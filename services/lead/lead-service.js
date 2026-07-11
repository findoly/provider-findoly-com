const Provider=require('../../models/Provider');
const LeadDistribution=require('../../models/LeadDistribution');
const WalletTransaction=require('../../models/WalletTransaction');
const Enquiry=require('../../models/Enquiry');
const {createId}=require('../../utils/id');
const {getPagination,pageResult}=require('../../utils/pagination');

function mask(distribution){const unlocked=distribution.contactUnlocked===true||distribution.status==='unlocked';const data={...distribution,leadDistributionId:distribution.leadDistributionId||distribution.id||String(distribution._id)};if(!unlocked){delete data.customerMobile;delete data.customerEmail;delete data.customerAddress;if(data.contactSnapshot)data.contactSnapshot=null;}return data;}
async function list(providerId,filters={}){const{page,limit,skip}=getPagination(filters);const q={providerId};if(filters.status==='unlocked')q.contactUnlocked=true;else if(filters.status)q.status=filters.status;else q.status={$in:['offered','unlocked']};if(filters.categorySlug)q.categorySlug=filters.categorySlug;if(filters.city)q.city=new RegExp(String(filters.city),'i');if(filters.q){const r=new RegExp(String(filters.q),'i');q.$or=[{leadTitle:r},{serviceType:r},{category:r},{city:r},{categorySlug:r},{requirementId:r},{leadDistributionId:r}];}if(filters.startDate||filters.endDate){q.distributedAt={};if(filters.startDate)q.distributedAt.$gte=new Date(`${filters.startDate}T00:00:00.000+05:30`);if(filters.endDate)q.distributedAt.$lte=new Date(`${filters.endDate}T23:59:59.999+05:30`);}const[data,total]=await Promise.all([LeadDistribution.find(q).sort({distributedAt:-1}).skip(skip).limit(limit).lean(),LeadDistribution.countDocuments(q)]);return pageResult(data.map(mask),total,page,limit);}
async function get(providerId,distributionId){const doc=await LeadDistribution.findOne({providerId,$or:[{leadDistributionId:distributionId},{id:distributionId},{_id:distributionId}]}).lean();if(!doc)throw Object.assign(new Error('Lead offer not found'),{status:404});return mask(doc);}
async function unlock(providerId,distributionId){
  const query={providerId,$or:[{leadDistributionId:distributionId},{id:distributionId},{_id:distributionId}]};
  const existing=await LeadDistribution.findOne(query).lean();
  if(!existing)throw Object.assign(new Error('Lead offer not found'),{status:404});
  if(existing.contactUnlocked||existing.status==='unlocked')return mask(existing);
  if(existing.status!=='offered')throw Object.assign(new Error(`Lead is ${existing.status}`),{status:409});

  const claimed=await LeadDistribution.findOneAndUpdate({...query,status:'offered',contactUnlocked:{$ne:true}},{$set:{status:'unlocking',updatedAt:new Date()}},{new:true});
  if(!claimed){const latest=await LeadDistribution.findOne(query).lean();if(latest?.contactUnlocked)return mask(latest);throw Object.assign(new Error('Lead is being unlocked in another request'),{status:409});}

  const price=Number(claimed.leadPricePaise||0);
  const provider=await Provider.findOneAndUpdate({$and:[{$or:[{providerId},{id:providerId},{_id:providerId}]},{walletBalancePaise:{$gte:price}}]},{$inc:{walletBalancePaise:-price},$set:{walletUpdatedAt:new Date(),updatedAt:new Date()}},{new:true});
  if(!provider){await LeadDistribution.updateOne({leadDistributionId:claimed.leadDistributionId,status:'unlocking'},{$set:{status:'offered',updatedAt:new Date()}});throw Object.assign(new Error('Insufficient wallet balance'),{status:402});}

  const before=provider.walletBalancePaise+price;
  try{
    const transaction=await WalletTransaction.create({walletTransactionId:createId('wallet_txn'),providerId,type:'debit',amountPaise:price,currency:'INR',balanceBeforePaise:before,balanceAfterPaise:provider.walletBalancePaise,status:'posted',source:'lead_unlock',referenceId:claimed.leadDistributionId,idempotencyKey:`lead-unlock:${providerId}:${claimed.leadDistributionId}`,description:`Unlocked ${claimed.leadTitle||'lead'}`});
    const unlocked=await LeadDistribution.findOneAndUpdate({leadDistributionId:claimed.leadDistributionId,status:'unlocking'},{$set:{contactUnlocked:true,status:'unlocked',unlockedAt:new Date(),walletTransactionId:transaction.walletTransactionId,updatedAt:new Date()}},{new:true});
    await Enquiry.updateOne({$or:[{enquiryId:claimed.requirementId},{id:claimed.requirementId},{_id:claimed.requirementId}]},{$inc:{unlockedCount:1},$set:{updatedAt:new Date()}});
    return mask(unlocked.toObject());
  }catch(error){
    await Provider.updateOne({$or:[{providerId},{id:providerId},{_id:providerId}]},{$inc:{walletBalancePaise:price},$set:{walletUpdatedAt:new Date(),updatedAt:new Date()}}).catch(()=>{});
    await LeadDistribution.updateOne({leadDistributionId:claimed.leadDistributionId,status:'unlocking'},{$set:{status:'offered',updatedAt:new Date()}}).catch(()=>{});
    if(error?.code===11000){const latest=await LeadDistribution.findOne(query).lean();if(latest?.contactUnlocked)return mask(latest);}
    throw error;
  }
}
module.exports={mask,list,get,unlock};
