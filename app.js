require('dotenv').config();
const path=require('path');
const express=require('express');
const cookieParser=require('cookie-parser');
const morgan=require('morgan');
const connectDatabase=require('./db/connection');
const {attachProvider}=require('./middleware/auth');
const {notFound,errorHandler}=require('./middleware/error');
const walletController=require('./controllers/walletController');

const app=express();
app.locals.appName=process.env.APP_NAME||'Provider Lead Portal';
app.locals.apiBase='/api';
app.set('view engine','ejs');
app.set('views',path.join(__dirname,'views'));

app.use(morgan(process.env.NODE_ENV==='production'?'combined':'dev'));
app.post('/api/webhooks/razorpay',express.raw({type:'application/json',limit:'1mb'}),walletController.webhook);
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:false,limit:'1mb'}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public')));
app.use(attachProvider);

app.get('/api/health',(req,res)=>res.json({success:true,data:{service:'provider',database:require('mongoose').connection.name||null}}));
app.use('/',require('./routes/frontend'));
app.use('/api',require('./routes/main'));
app.use(notFound);
app.use(errorHandler);

if(process.env.SKIP_DB!=='true')connectDatabase().catch(error=>console.error('MongoDB connection error:',error.message));
module.exports=app;
