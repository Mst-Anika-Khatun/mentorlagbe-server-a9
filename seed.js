import dns from "node:dns";
dns.setServers(["8.8.8.8", "8.8.4.4"]);

import 'dotenv/config';import {MongoClient} from 'mongodb';const c=await MongoClient.connect(process.env.MONGODB_URI);const col=c.db('mentorlagbe').collection('tuitions');const subjects=['Mathematics','English','Physics','Chemistry','Biology','ICT','Bangla','Accounting','Economics','Statistics','Science','Programming'];for(let i=0;i<subjects.length;i++)await col.updateOne({seed:i},{$set:{seed:i,title:subjects[i]+' home tuition',subject:subjects[i],location:['Rajshahi','Dhaka','Khulna'][i%3],salary:3000+i*350,description:'Weekly lessons for a motivated learner. Schedule can be discussed.',status:'approved',active:true,email:'demo@example.com'}},{upsert:true});await c.close();
