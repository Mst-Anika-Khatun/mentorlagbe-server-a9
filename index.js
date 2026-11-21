import dns from "node:dns";

dns.setServers(["8.8.8.8", "8.8.4.4"]);

import 'dotenv/config';
import express from 'express'; import cors from 'cors'; import {MongoClient,ObjectId} from 'mongodb'; import {createRemoteJWKSet,jwtVerify} from 'jose'; import Stripe from 'stripe';
const app=express(), url=process.env.CLIENT_URL || 'http://localhost:3000';
app.use(cors({origin:url})); app.use(express.json());
const mongo=await MongoClient.connect(process.env.MONGODB_URI), db=mongo.db('mentorlagbe');
const users=db.collection('users'), tuitions=db.collection('tuitions'), applications=db.collection('applications'), payments=db.collection('payments');
await applications.createIndex({tuitionId:1,email:1},{unique:true}); await payments.createIndex({sessionId:1},{unique:true});
const jwks=createRemoteJWKSet(new URL(url+'/api/auth/jwks')); const stripe=process.env.STRIPE_SECRET_KEY?new Stripe(process.env.STRIPE_SECRET_KEY):null;
const id=x=>new ObjectId(x); const fail=(r,m,s=400)=>r.status(s).json({error:m});
async function auth(req,res,next){try{const {payload}=await jwtVerify(req.headers.authorization?.split(' ')[1],jwks,{issuer:url,audience:url}); const email=payload.email; if(!email)return fail(res,'Missing email',401); req.email=email; req.account=await users.findOne({email}); next()}catch{return fail(res,'Sign in required',401)}}
const role=(...roles)=>(q,r,n)=>roles.includes(q.account?.role)?n():fail(r,'Forbidden',403);
app.get('/',(q,r)=>r.json({name:'MentorLagbe API'}));
app.post('/profile',auth,async(q,r)=>{const role=q.email===process.env.ADMIN_EMAIL?'Admin':q.body.role==='Tutor'?'Tutor':'Student'; await users.updateOne({email:q.email},{$setOnInsert:{email:q.email,role,plan:'free'},$set:{name:String(q.body.name||''),photo:String(q.body.photo||'')}},{upsert:true});r.json(await users.findOne({email:q.email}))});
app.get('/profile',auth,(q,r)=>r.json(q.account));
app.get('/tuitions',async(q,r)=>r.json(await tuitions.find({status:'approved',active:true}).sort({_id:-1}).toArray()));
app.get('/tuitions/:id',async(q,r)=>{const t=await tuitions.findOne({_id:id(q.params.id),status:'approved',active:true});t?r.json(t):fail(r,'Not found',404)});
app.post('/tuitions',auth,role('Tutor'),async(q,r)=>{if(q.account.plan!=='pro'&&await tuitions.countDocuments({email:q.email})>=2)return fail(r,'Upgrade to Pro');const {title,subject,location,salary,description}=q.body;if(!title||!subject||!location||!salary)return fail(r,'Complete all fields');r.json(await tuitions.insertOne({title,subject,location,salary:Number(salary),description,email:q.email,status:'pending',active:true,createdAt:new Date()}))});
app.get('/mine',auth,role('Tutor'),async(q,r)=>r.json(await tuitions.find({email:q.email}).toArray()));
app.patch('/tuitions/:id',auth,role('Tutor'),async(q,r)=>{const fields={};for(const k of ['title','subject','location','salary','description','active'])if(k in q.body)fields[k]=q.body[k];r.json(await tuitions.updateOne({_id:id(q.params.id),email:q.email},{$set:{...fields,status:'pending'}}))});
app.delete('/tuitions/:id',auth,role('Tutor'),async(q,r)=>r.json(await tuitions.deleteOne({_id:id(q.params.id),email:q.email})));
app.post('/applications',auth,role('Student'),async(q,r)=>{const {tuitionId,phone,schedule,note}=q.body;const t=await tuitions.findOne({_id:id(tuitionId),status:'approved',active:true});if(!t||!phone||!schedule)return fail(r,'Invalid application');try{r.json(await applications.insertOne({tuitionId,email:q.email,tutor:t.email,title:t.title,phone,schedule,note,status:'pending'}))}catch(e){if(e.code===11000)return fail(r,'Already applied');throw e}});
app.get('/applications',auth,async(q,r)=>r.json(await applications.find(q.account?.role==='Tutor'?{tutor:q.email}:{email:q.email}).toArray()));
app.patch('/applications/:id',auth,role('Tutor'),async(q,r)=>{if(!['accepted','rejected'].includes(q.body.status))return fail(r,'Invalid status');r.json(await applications.updateOne({_id:id(q.params.id),tutor:q.email,status:'pending'},{$set:{status:q.body.status}}))});
app.delete('/applications/:id',auth,role('Student'),async(q,r)=>r.json(await applications.deleteOne({_id:id(q.params.id),email:q.email,status:'pending'})));
app.get('/admin/:collection',auth,role('Admin'),async(q,r)=>{if(!['users','tuitions','payments'].includes(q.params.collection))return fail(r,'Invalid collection');r.json(await db.collection(q.params.collection).find().toArray())});
app.patch('/admin/tuitions/:id',auth,role('Admin'),async(q,r)=>{if(!['approved','rejected'].includes(q.body.status))return fail(r,'Invalid status');r.json(await tuitions.updateOne({_id:id(q.params.id)},{$set:{status:q.body.status}}))});
app.post('/checkout',auth,role('Student','Tutor'),async(q,r)=>{if(!stripe)return fail(r,'Stripe not configured');const session=await stripe.checkout.sessions.create({mode:'payment',line_items:[{price_data:{currency:'usd',product_data:{name:q.account.role+' Pro'},unit_amount:q.account.role==='Tutor'?1500:1000},quantity:1}],metadata:{email:q.email},success_url:url+'/payment/success?session_id={CHECKOUT_SESSION_ID}',cancel_url:url+'/payment/cancel'});r.json({url:session.url})});
app.post('/payment/verify',auth,async(q,r)=>{const s=await stripe.checkout.sessions.retrieve(q.body.sessionId);if(s.payment_status!=='paid'||s.metadata.email!==q.email)return fail(r,'Payment not verified');await payments.updateOne({sessionId:s.id},{$setOnInsert:{sessionId:s.id,email:q.email,amount:s.amount_total/100,status:'paid',date:new Date()}},{upsert:true});await users.updateOne({email:q.email},{$set:{plan:'pro'}});r.json({success:true})});
app.get('/payments',auth,async(q,r)=>r.json(await payments.find({email:q.email}).toArray()));
app.use((e,q,r,n)=>{console.error(e);r.status(500).json({error:'Request failed'})});app.listen(process.env.PORT||5000);
