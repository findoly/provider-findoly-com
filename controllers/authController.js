const service=require('../services/auth/auth-service');
async function sendOtp(req,res,next){try{res.json({success:true,data:await service.sendOtp(req.body.mobile)});}catch(e){next(e);}}
async function verifyOtp(req,res,next){try{const provider=await service.verifyOtp(req.body.mobile,req.body.otp);const token=service.sign(provider);res.cookie(process.env.AUTH_COOKIE_NAME||'provider_auth',token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',maxAge:Number(process.env.AUTH_COOKIE_DAYS||30)*86400000});res.json({success:true,data:provider});}catch(e){next(e);}}
function logout(req,res){res.clearCookie(process.env.AUTH_COOKIE_NAME||'provider_auth');res.json({success:true});}
module.exports={sendOtp,verifyOtp,logout};
