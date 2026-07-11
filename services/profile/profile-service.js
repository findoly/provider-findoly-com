const Provider=require('../../models/Provider');
async function get(providerId){const provider=await Provider.findOne({$or:[{providerId},{id:providerId},{_id:providerId}]}).lean();if(!provider)throw Object.assign(new Error('Provider account not found'),{status:404});return{...provider,providerId:provider.providerId||provider.id||String(provider._id)};}
module.exports={get};
