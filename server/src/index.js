require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { rateLimit } = require('express-rate-limit');
const { pool, query } = require('./db');
const app = express();
if (process.env.NODE_ENV === 'production' && !(process.env.SESSION_SECRET || 'local-only-change-this-secret')) throw new Error('SESSION_SECRET must be set in production.');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https:'], scriptSrc: ["'self'"], connectSrc: ["'self'"] } } }));
app.use(express.json({ limit: '1mb' }));
app.use(session({ store: new PgSession({ pool, createTableIfMissing: true }), secret: process.env.SESSION_SECRET || 'local-only-change-this-secret', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 } }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
const bookingLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const emailCodeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const auth = (req,res,next) => req.session.admin ? next() : res.status(401).json({ error:'Admin login required.' });
const admin = (req,res,next) => req.session.admin?.role === 'admin' ? next() : res.status(403).json({ error:'Admin permission required.' });
const customerAuth = (req,res,next) => req.session.customer?.email ? next() : res.status(401).json({error:'Sign in with your email to view your profile.'});
app.use('/api', (req,res,next) => { if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next(); const origin=req.get('origin'); const allowed=process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`; if (origin && origin !== allowed) return res.status(403).json({error:'Request origin is not allowed.'}); next(); });
const settings = async () => { const r = await query('SELECT key,value FROM business_settings'); return Object.fromEntries(r.rows.map(x=>[x.key,x.value])); };
const todayAtTen = (date) => { const [y,m,day]=date.split('-').map(Number); const probe=new Date(Date.UTC(y,m-1,day)); if(probe.toISOString().slice(0,10)!==date) throw new Error('Invalid check-in date.'); return new Date(`${date}T10:00:00+05:30`); };
const dateAfterDays = (date, days) => { const [y,m,day]=date.split('-').map(Number); return new Date(Date.UTC(y,m-1,day+days)).toISOString().slice(0,10); };
const reference = () => 'MD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
const normalizePhone = value => { const digits=String(value||'').replace(/\D/g,''); return digits.length===12&&digits.startsWith('91')?digits.slice(2):digits; };
const identityKey = () => crypto.createHash('sha256').update(process.env.IDENTITY_ENCRYPTION_KEY || process.env.SESSION_SECRET || 'local-only-change-this-secret').digest();
const encryptIdentity = value => { const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',identityKey(),iv), encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]); return [iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.'); };
const decryptIdentity = value => { const [iv,tag,data]=String(value).split('.'), decipher=crypto.createDecipheriv('aes-256-gcm',identityKey(),Buffer.from(iv,'base64url')); decipher.setAuthTag(Buffer.from(tag,'base64url')); return Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8'); };
const sendBookingWhatsApp = async booking => {
  const { WHATSAPP_ACCESS_TOKEN:token, WHATSAPP_PHONE_NUMBER_ID:phoneId, WHATSAPP_TEMPLATE_NAME:templateName } = process.env;
  if (!token || !phoneId || !templateName || !booking.whatsapp_opt_in || booking.whatsapp_notified_at) return false;
  let recipient=String(booking.phone).replace(/\D/g,'');if(recipient.length===10)recipient='91'+recipient;
  const response=await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_API_VERSION||'v26.0'}/${phoneId}/messages`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:recipient,type:'template',template:{name:templateName,language:{code:process.env.WHATSAPP_TEMPLATE_LANGUAGE||'en'},components:[{type:'body',parameters:[{type:'text',text:booking.name},{type:'text',text:booking.reference},{type:'text',text:String(booking.advance_amount)},{type:'text',text:new Date(booking.check_in).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'})},{type:'text',text:new Date(booking.expected_check_out).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'})}]}]}})});
  if(!response.ok) throw new Error(`WhatsApp API returned ${response.status}`);
  return true;
};
const sendBookingEmail = async booking => {
  const { RESEND_API_KEY:apiKey, RESEND_FROM_EMAIL:from }=process.env;
  if(!apiKey||!from||!booking.email||booking.email_notified_at)return false;
  const checkIn=new Date(booking.check_in).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'}),checkOut=new Date(booking.expected_check_out).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'});
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':`booking-confirmation/${booking.id}`},body:JSON.stringify({from,to:booking.email,subject:`Mariyam Dormitory booking confirmed · ${booking.reference}`,text:`Hello ${booking.name},\n\nYour payment has been verified and your booking is confirmed.\n\nBooking reference: ${booking.reference}\nBed: ${booking.bed_label||booking.category}\nCheck-in: ${checkIn}\nCheck-out: ${checkOut}\nTotal paid: ₹${Number(booking.advance_amount||booking.amount).toLocaleString('en-IN')}\n\nPlease show the ID you entered at check-in.\n\nMariyam Dormitory, Mumbai`})});
  if(!response.ok)throw new Error(`Email API returned ${response.status}`);
  return true;
};
app.get('/api/health', async (req,res) => { try { await query('SELECT 1'); res.json({ ok:true }); } catch { res.status(503).json({ ok:false }); } });
app.post('/api/profile/request-code',emailCodeLimiter,async(req,res)=>{
  const email=String(req.body?.email||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return res.status(400).json({error:'Enter a valid email address.'});
  if(!process.env.RESEND_API_KEY||!process.env.RESEND_FROM_EMAIL)return res.status(503).json({error:'Email login is not enabled yet. Email service needs to be set up first.'});
  const code=String(crypto.randomInt(100000,1000000)),codeHash=crypto.createHmac('sha256',(process.env.SESSION_SECRET || 'local-only-change-this-secret')).update(`${email}:${code}`).digest('hex');
  try{
    await query('DELETE FROM email_login_codes WHERE email=$1 OR expires_at<now()',[email]);
    const saved=await query("INSERT INTO email_login_codes(email,code_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes') RETURNING id",[email,codeHash]);
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`profile-login/${saved.rows[0].id}`},body:JSON.stringify({from:process.env.RESEND_FROM_EMAIL,to:email,subject:'Your Mariyam Dormitory sign-in code',text:`Your sign-in code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`})});
    if(!response.ok){await query('DELETE FROM email_login_codes WHERE id=$1',[saved.rows[0].id]);throw new Error(`Email API returned ${response.status}`);}
    res.json({ok:true,message:'A sign-in code was sent to your email. It expires in 10 minutes.'});
  }catch(e){console.error('Profile login email failed:',e.message);res.status(502).json({error:'Could not send the sign-in email. Check the email service settings and try again.'});}
});
app.post('/api/profile/verify-code',emailCodeLimiter,async(req,res)=>{
  const email=String(req.body?.email||'').trim().toLowerCase(),code=String(req.body?.code||'').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^[0-9]{6}$/.test(code))return res.status(400).json({error:'Enter your email and the 6-digit code.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const found=await client.query("SELECT id,code_hash,attempts FROM email_login_codes WHERE email=$1 AND used_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[email]);
    if(!found.rowCount||found.rows[0].attempts>=5){await client.query('ROLLBACK');return res.status(401).json({error:'That code expired or is no longer valid. Request a new one.'});}
    const expected=Buffer.from(found.rows[0].code_hash,'hex'),actual=Buffer.from(crypto.createHmac('sha256',(process.env.SESSION_SECRET || 'local-only-change-this-secret')).update(`${email}:${code}`).digest('hex'),'hex');
    if(expected.length!==actual.length||!crypto.timingSafeEqual(expected,actual)){await client.query('UPDATE email_login_codes SET attempts=attempts+1 WHERE id=$1',[found.rows[0].id]);await client.query('COMMIT');return res.status(401).json({error:'That code is incorrect. Check the email and try again.'});}
    await client.query('UPDATE email_login_codes SET used_at=now() WHERE id=$1',[found.rows[0].id]);
    await client.query('COMMIT');
    req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Unable to start your profile session.'});req.session.customer={email};res.json({email});});
  }catch{await client.query('ROLLBACK').catch(()=>{});res.status(500).json({error:'Unable to verify the sign-in code.'});}
  finally{client.release();}
});
app.get('/api/profile/me',customerAuth,(req,res)=>res.json({email:req.session.customer.email}));
app.post('/api/profile/logout',customerAuth,(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/profile/bookings',customerAuth,async(req,res)=>{
  try{
    const result=await query(`SELECT b.reference,b.category,b.check_in,b.expected_check_out,b.duration_days,b.status,b.payment_status,b.amount,b.advance_amount,bd.label bed_label FROM bookings b JOIN customers c ON c.id=b.customer_id LEFT JOIN beds bd ON bd.id=b.bed_id WHERE lower(c.email)=lower($1) ORDER BY b.created_at DESC LIMIT 100`,[req.session.customer.email]);
    const s=await settings();
    for(const booking of result.rows){if(booking.status==='pending'&&booking.payment_status==='pending'&&Number(booking.advance_amount)>0){const uri='upi://pay?'+new URLSearchParams({pa:s.business.upiId,pn:s.business.name,am:Number(booking.advance_amount).toFixed(2),cu:'INR',tn:`Dormitory booking ${booking.reference}`}).toString();booking.qrCodeDataUrl=await QRCode.toDataURL(uri,{width:220,margin:1,errorCorrectionLevel:'M'});}}
    res.json({email:req.session.customer.email,bookings:result.rows});
  }catch{res.status(500).json({error:'Unable to load your bookings.'});}
});
app.get('/api/public/settings', async (req,res) => { try { const s=await settings(); const {upiId,...publicBusiness}=s.business; res.json({...s,business:publicBusiness}); } catch { res.status(500).json({error:'Unable to load business settings.'}); } });
app.get('/api/availability', async (req,res) => {
  try {
    const { date, category='upper', count='1', days='1' } = req.query; const n = Math.max(1, Math.min(35, Number(count))), duration=Number(days);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date||'') || !['upper','lower'].includes(category) || !Number.isInteger(duration) || duration<1 || duration>30) return res.status(400).json({error:'Choose a valid date, bed type and stay duration (1–30 days).'});
    const start = todayAtTen(date), end = new Date(start.getTime()+duration*86400000);
    await query("UPDATE bookings SET status='cancelled',identity_ciphertext=NULL WHERE status='pending' AND created_at < now()-interval '30 minutes'");
    const r = await query(`SELECT b.id,b.label,b.category FROM beds b WHERE b.category=$1 AND b.status='available' AND NOT EXISTS (SELECT 1 FROM bookings k WHERE k.bed_id=b.id AND (k.status IN ('confirmed','checked_in') OR (k.status='pending' AND k.created_at >= now()-interval '30 minutes')) AND k.check_in < $3 AND k.expected_check_out > $2) ORDER BY b.label`, [category,end,start]);
    const s=await settings(), price=category==='upper'?s.business.upperPrice:s.business.lowerPrice;
    res.json({date,category,available:r.rows.length, beds:r.rows.slice(0,n), bedLabels:r.rows.map(b=>b.label), price, totalPrice:price*duration, durationDays:duration, durationHours:24*duration, checkIn:'10:00', checkOutDate:dateAfterDays(date,duration), checkOut:'10:00'});
  } catch(e) { res.status(400).json({error:e.message||'Unable to check availability.'}); }
});
app.post('/api/bookings', bookingLimiter, async (req,res) => {
  const {date,checkOutDate,category,count,name,phone,email,identityType,identityNumber,whatsappConsent}=req.body||{}; const n=Number(count),duration=Math.round((Date.parse(`${checkOutDate}T00:00:00Z`)-Date.parse(`${date}T00:00:00Z`))/86400000);
  const validIdentityTypes=['aadhaar','pan','voter','driving_license'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date||'') || !/^\d{4}-\d{2}-\d{2}$/.test(checkOutDate||'') || !['upper','lower'].includes(category) || !Number.isInteger(n) || n<1 || n>10 || !Number.isInteger(duration) || duration<1 || duration>30 || !name?.trim() || !/^\+?[0-9 ()-]{8,18}$/.test(phone||'') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email||'') || !validIdentityTypes.includes(identityType) || !identityNumber?.trim() || identityNumber.trim().length>24 || whatsappConsent!==true) return res.status(400).json({error:'Please complete the required dates, email, identity proof details, and WhatsApp consent.'});
  const client=await pool.connect();
  try {
    const s=await settings(), start=todayAtTen(date), end=todayAtTen(checkOutDate), price=category==='upper'?s.business.upperPrice:s.business.lowerPrice, totalPrice=price*duration, encryptedIdentity=encryptIdentity(identityNumber.trim().replace(/\s+/g,'').toUpperCase());
    if(start.getTime()<Date.now()) return res.status(400).json({error:'Choose a future check-in date.'});
    await client.query('BEGIN');
    const customer=await client.query(`INSERT INTO customers(name,phone,email) VALUES($1,$2,$3) ON CONFLICT(phone) DO UPDATE SET name=EXCLUDED.name,email=COALESCE(EXCLUDED.email,customers.email) RETURNING id`,[name.trim(),phone.trim(),email?.trim()||null]);
    await client.query("UPDATE bookings SET status='cancelled',identity_ciphertext=NULL WHERE status='pending' AND created_at < now()-interval '30 minutes'");
    const beds=await client.query(`SELECT b.id,b.label FROM beds b WHERE b.category=$1 AND b.status='available' AND NOT EXISTS (SELECT 1 FROM bookings k WHERE k.bed_id=b.id AND (k.status IN ('confirmed','checked_in') OR (k.status='pending' AND k.created_at >= now()-interval '30 minutes')) AND k.check_in<$3 AND k.expected_check_out>$2) ORDER BY b.label FOR UPDATE OF b SKIP LOCKED LIMIT $4`,[category,start,end,n]);
    if(beds.rowCount<n) { await client.query('ROLLBACK'); return res.status(409).json({error:'Not enough beds are available for that date.'}); }
    const created=[];
    for(const bed of beds.rows) { const ref=reference(); const primary=created.length===0, b=await client.query(`INSERT INTO bookings(reference,customer_id,bed_id,category,check_in,expected_check_out,duration_days,status,payment_status,amount,advance_amount,identity_type,identity_ciphertext,whatsapp_opt_in) VALUES($1,$2,$3,$4,$5,$6,$7,'pending','pending',$8,$9,$10,$11,$12) RETURNING reference,check_in,expected_check_out,duration_days,amount,advance_amount`,[ref,customer.rows[0].id,bed.id,category,start,end,duration,totalPrice,primary?totalPrice*n:0,identityType,encryptedIdentity,whatsappConsent===true]); created.push({...b.rows[0],bedLabel:bed.label}); }
    await client.query('COMMIT');
    const totalAmount=created.reduce((sum,b)=>sum+Number(b.amount),0), upiUri='upi://pay?'+new URLSearchParams({pa:s.business.upiId,pn:s.business.name,am:totalAmount.toFixed(2),cu:'INR',tn:`Dormitory booking ${created[0].reference}`}).toString(), qrCodeDataUrl=await QRCode.toDataURL(upiUri,{width:240,margin:1,errorCorrectionLevel:'M'});
    res.status(201).json({bookings:created,message:'Request received. Payment must be verified by staff.',totalAmount,durationDays:duration,checkOutDate,qrCodeDataUrl});
  } catch(e) { await client.query('ROLLBACK').catch(()=>{}); res.status(e.code==='23P01'||e.code==='23505'?409:500).json({error:e.code==='23505'?'This UTR has already been submitted.':'Unable to create booking.'}); }
  finally {client.release();}
});
app.get('/api/bookings/:reference', async(req,res)=>{ try { const r=await query(`SELECT b.reference,b.category,b.check_in,b.expected_check_out,b.duration_days,b.status,b.payment_status,b.amount,b.advance_amount,bd.label bed_label,c.name FROM bookings b JOIN customers c ON c.id=b.customer_id LEFT JOIN beds bd ON bd.id=b.bed_id WHERE b.reference=$1`,[req.params.reference]); if(!r.rowCount)return res.status(404).json({error:'Booking not found.'});const booking=r.rows[0];if(booking.status==='pending'&&booking.payment_status==='pending'&&Number(booking.advance_amount)>0){const s=await settings(),uri='upi://pay?'+new URLSearchParams({pa:s.business.upiId,pn:s.business.name,am:Number(booking.advance_amount).toFixed(2),cu:'INR',tn:`Dormitory booking ${booking.reference}`}).toString();booking.qrCodeDataUrl=await QRCode.toDataURL(uri,{width:240,margin:1,errorCorrectionLevel:'M'});}res.json(booking); }catch{res.status(500).json({error:'Unable to find booking.'});} });
app.post('/api/profile',bookingLimiter,async(req,res)=>{
  const ref=String(req.body?.reference||'').trim(),phone=normalizePhone(req.body?.phone);
  if(!ref||phone.length<10||phone.length>12)return res.status(400).json({error:'Enter your booking reference and the phone number used for that booking.'});
  try{
    const owner=await query('SELECT b.customer_id,c.phone FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.reference=$1',[ref]);
    if(!owner.rowCount||normalizePhone(owner.rows[0].phone)!==phone)return res.status(404).json({error:'We could not match that reference and phone number.'});
    const result=await query(`SELECT b.reference,b.category,b.check_in,b.expected_check_out,b.duration_days,b.status,b.payment_status,b.amount,b.advance_amount,bd.label bed_label FROM bookings b LEFT JOIN beds bd ON bd.id=b.bed_id WHERE b.customer_id=$1 ORDER BY b.created_at DESC LIMIT 50`,[owner.rows[0].customer_id]);
    const s=await settings();
    for(const booking of result.rows){if(booking.status==='pending'&&booking.payment_status==='pending'&&Number(booking.advance_amount)>0){const uri='upi://pay?'+new URLSearchParams({pa:s.business.upiId,pn:s.business.name,am:Number(booking.advance_amount).toFixed(2),cu:'INR',tn:`Dormitory booking ${booking.reference}`}).toString();booking.qrCodeDataUrl=await QRCode.toDataURL(uri,{width:220,margin:1,errorCorrectionLevel:'M'});}}
    res.json({bookings:result.rows});
  }catch{res.status(500).json({error:'Unable to load your bookings.'});}
});
app.post('/api/payments', bookingLimiter, async(req,res)=>{const{reference:ref,utr}=req.body||{};if(!ref||!utr?.trim())return res.status(400).json({error:'Booking reference and UTR are required.'});try{const r=await query(`INSERT INTO payments(booking_id,utr,amount) SELECT id,$2,advance_amount FROM bookings WHERE reference=$1 RETURNING id`,[ref,utr.trim()]);if(!r.rowCount)return res.status(404).json({error:'Booking not found.'});await query("UPDATE bookings SET payment_status='pending_verification' WHERE reference=$1",[ref]);res.status(201).json({message:'Payment submitted for manual verification.'});}catch(e){res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'This UTR has already been submitted.':'Unable to submit payment.'});}});
app.post('/api/admin/login',loginLimiter,async(req,res)=>{try{const email=String(req.body.email||'').toLowerCase().trim(), password=String(req.body.password||'');const r=await query('SELECT id,email,password_hash,role FROM admin_users WHERE email=$1 AND active=TRUE',[email]);if(!r.rowCount||!await bcrypt.compare(password,r.rows[0].password_hash))return res.status(401).json({error:'Email or password is incorrect.'});req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Unable to start session.'});req.session.admin={id:r.rows[0].id,email:r.rows[0].email,role:r.rows[0].role};res.json({email:r.rows[0].email,role:r.rows[0].role});});}catch{res.status(500).json({error:'Unable to log in.'});}});
app.post('/api/admin/logout',auth,(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/admin/me',auth,(req,res)=>res.json(req.session.admin));
app.get('/api/admin/summary',auth,async(req,res)=>{try{const r=await query(`SELECT (SELECT count(*) FROM beds) total_beds,(SELECT count(*) FROM beds b WHERE b.status='available' AND NOT EXISTS (SELECT 1 FROM bookings k WHERE k.bed_id=b.id AND k.status='checked_in')) available_beds,(SELECT count(*) FROM bookings WHERE status='checked_in') occupied_beds,(SELECT count(*) FROM bookings) total_bookings,(SELECT count(*) FROM bookings WHERE status='pending') pending_bookings,(SELECT count(*) FROM payments WHERE status='pending_verification') pending_payments,(SELECT COALESCE(sum(amount),0) FROM payments WHERE status='verified') verified_collection`);res.json(r.rows[0]);}catch{res.status(500).json({error:'Unable to load dashboard.'});}});
app.get('/api/admin/bookings',auth,async(req,res)=>{try{const r=await query(`SELECT b.*,c.name,c.phone,c.email,bd.label bed_label,p.utr,p.status payment_record_status FROM bookings b JOIN customers c ON c.id=b.customer_id LEFT JOIN beds bd ON bd.id=b.bed_id LEFT JOIN LATERAL (SELECT utr,status FROM payments WHERE booking_id=b.id ORDER BY created_at DESC LIMIT 1) p ON TRUE ORDER BY b.created_at DESC LIMIT 300`);for(const row of r.rows){row.identity_number=row.identity_ciphertext?decryptIdentity(row.identity_ciphertext):null;delete row.identity_ciphertext;}res.json(r.rows);}catch{res.status(500).json({error:'Unable to load bookings.'});}});
app.patch('/api/admin/bookings/:id',auth,async(req,res)=>{
  const{status,paymentStatus,reason}=req.body||{},allowed=['pending','confirmed','rejected','cancelled','checked_in','checked_out'];
  if(!allowed.includes(status))return res.status(400).json({error:'Invalid booking status.'});
  if(paymentStatus&&!['pending','pending_verification','verified','rejected','refund_pending','refunded'].includes(paymentStatus))return res.status(400).json({error:'Invalid payment status.'});
  const c=await pool.connect();let notifyBooking=null,whatsappSent=false,emailSent=false;
  try{
    await c.query('BEGIN');
    const existing=await c.query('SELECT status,payment_status FROM bookings WHERE id=$1 FOR UPDATE',[req.params.id]);
    if(!existing.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'Booking not found.'});}
    const resultingPayment=paymentStatus||existing.rows[0].payment_status;
    if(status==='confirmed'&&resultingPayment!=='verified'){await c.query('ROLLBACK');return res.status(409).json({error:'Verify the full payment before confirming this booking.'});}
    const r=await c.query('UPDATE bookings SET status=$1,actual_check_in=CASE WHEN $1=\'checked_in\' THEN now() ELSE actual_check_in END,actual_check_out=CASE WHEN $1=\'checked_out\' THEN now() ELSE actual_check_out END,identity_ciphertext=CASE WHEN $1 IN (\'checked_in\',\'checked_out\',\'rejected\',\'cancelled\') THEN NULL ELSE identity_ciphertext END WHERE id=$2 RETURNING id,reference',[status,req.params.id]);
    if(!r.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'Booking not found.'});}
    if(paymentStatus){await c.query('UPDATE bookings SET payment_status=$1 WHERE id=$2',[paymentStatus,r.rows[0].id]);await c.query('UPDATE payments SET status=$1,verified_by=$2,verified_at=CASE WHEN $1 IN (\'verified\',\'rejected\') THEN now() ELSE verified_at END WHERE id=(SELECT id FROM payments WHERE booking_id=$3 ORDER BY created_at DESC LIMIT 1)',[paymentStatus,req.session.admin.id,r.rows[0].id]);}
    await c.query('INSERT INTO audit_logs(admin_id,action,entity,entity_id,details) VALUES($1,$2,\'booking\',$3,$4)',[req.session.admin.id,status,String(r.rows[0].id),JSON.stringify({reason:reason||null,paymentStatus:paymentStatus||null})]);
    const booking=await c.query('SELECT b.*,c.name,c.phone,c.email,bd.label bed_label FROM bookings b JOIN customers c ON c.id=b.customer_id LEFT JOIN beds bd ON bd.id=b.bed_id WHERE b.id=$1',[r.rows[0].id]);
    if(booking.rows[0].status==='confirmed'&&booking.rows[0].payment_status==='verified'&&((booking.rows[0].whatsapp_opt_in&&!booking.rows[0].whatsapp_notified_at)||(booking.rows[0].email&&!booking.rows[0].email_notified_at)))notifyBooking=booking.rows[0];
    await c.query('COMMIT');
    if(notifyBooking){
      try{whatsappSent=await sendBookingWhatsApp(notifyBooking);if(whatsappSent)await query('UPDATE bookings SET whatsapp_notified_at=now() WHERE id=$1',[notifyBooking.id]);}
      catch(err){console.error('WhatsApp booking confirmation failed:',err.message);}
      try{emailSent=await sendBookingEmail(notifyBooking);if(emailSent)await query('UPDATE bookings SET email_notified_at=now() WHERE id=$1',[notifyBooking.id]);}
      catch(err){console.error('Booking confirmation email failed:',err.message);}
    }
    res.json({ok:true,reference:r.rows[0].reference,whatsappSent,emailSent});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});res.status(e.code==='23P01'?409:500).json({error:e.code==='23P01'?'Bed conflicts with another confirmed booking.':'Unable to update booking.'});}
  finally{c.release();}
});
app.get('/api/admin/beds',auth,async(req,res)=>{try{const r=await query(`SELECT b.*,EXISTS(SELECT 1 FROM bookings k WHERE k.bed_id=b.id AND k.status='checked_in') occupied FROM beds b ORDER BY label`);res.json(r.rows);}catch{res.status(500).json({error:'Unable to load beds.'});}});
app.patch('/api/admin/beds/:id',auth,async(req,res)=>{
  const {status,label,category}=req.body||{};
  if(status!==undefined&&!['available','maintenance'].includes(status))return res.status(400).json({error:'Invalid bed status.'});
  if(category!==undefined&&!['upper','lower'].includes(category))return res.status(400).json({error:'Bed type must be upper or lower.'});
  if(label!==undefined&&(!String(label).trim()||String(label).trim().length>40))return res.status(400).json({error:'Bed name must be 1–40 characters.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const current=await client.query('SELECT * FROM beds WHERE id=$1 FOR UPDATE',[req.params.id]);
    if(!current.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Bed not found.'});}
    if(category&&category!==current.rows[0].category){
    const active=await client.query(`SELECT 1 FROM bookings WHERE bed_id=$1 AND expected_check_out>now() AND (status IN ('confirmed','checked_in') OR (status='pending' AND created_at>=now()-interval '30 minutes')) LIMIT 1`,[req.params.id]);
      if(active.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'This bed has an active or upcoming booking, so its type cannot be changed yet.'});}
    }
    const updated=await client.query(`UPDATE beds SET label=COALESCE($1,label),category=COALESCE($2,category),status=COALESCE($3,status) WHERE id=$4 RETURNING *`,[label===undefined?null:String(label).trim(),category??null,status??null,req.params.id]);
    await client.query('INSERT INTO audit_logs(admin_id,action,entity,entity_id,details) VALUES($1,$2,\'bed\',$3,$4)',[req.session.admin.id,'bed_updated',req.params.id,JSON.stringify({label:updated.rows[0].label,category:updated.rows[0].category,status:updated.rows[0].status})]);
    await client.query('COMMIT');res.json(updated.rows[0]);
  }catch(e){await client.query('ROLLBACK');res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'That bed name is already in use.':'Unable to update bed.'});}
  finally{client.release();}
});
app.get('/api/admin/settings',auth,async(req,res)=>{try{res.json(await settings());}catch{res.status(500).json({error:'Unable to load settings.'});}});
app.put('/api/admin/settings/business',admin,async(req,res)=>{const allowed=['name','hindiName','phone','email','address','instagram','upiId','upperPrice','lowerPrice','advanceAmount'];try{const s=await settings(),next={...s.business};for(const k of allowed)if(req.body[k]!==undefined)next[k]=req.body[k];for(const k of ['upperPrice','lowerPrice','advanceAmount'])if(!Number.isInteger(Number(next[k]))||Number(next[k])<0)return res.status(400).json({error:`${k} must be a non-negative whole number.`});await query(`INSERT INTO business_settings(key,value,updated_at) VALUES('business',$1,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[JSON.stringify(next)]);await query('INSERT INTO audit_logs(admin_id,action,entity,details) VALUES($1,\'settings_updated\',\'business\',$2)',[req.session.admin.id,JSON.stringify({changed:Object.keys(req.body).filter(k=>allowed.includes(k))})]);res.json(next);}catch{res.status(500).json({error:'Unable to save settings.'});}});
app.get('/api/admin/customers',auth,async(req,res)=>{try{const r=await query(`SELECT c.*,count(b.id)::int booking_count,coalesce(sum(p.amount) FILTER(WHERE p.status='verified'),0)::int paid_total FROM customers c LEFT JOIN bookings b ON b.customer_id=c.id LEFT JOIN payments p ON p.booking_id=b.id GROUP BY c.id ORDER BY c.created_at DESC LIMIT 300`);res.json(r.rows);}catch{res.status(500).json({error:'Unable to load customers.'});}});
app.get('/api/admin/payments',auth,async(req,res)=>{try{const r=await query(`SELECT p.*,b.reference,b.status booking_status,c.name,c.phone FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN customers c ON c.id=b.customer_id ORDER BY p.created_at DESC LIMIT 300`);res.json(r.rows);}catch{res.status(500).json({error:'Unable to load payments.'});}});
app.use(express.static(path.join(__dirname,'../../public')));
app.get('/admin/*',(req,res)=>res.sendFile(path.join(__dirname,'../../public/admin.html')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'../../public/index.html')));
const port=process.env.PORT||3000;app.listen(port,()=>console.log(`Mariyam Dormitory app listening on ${port}`));
