const test=require('node:test');const assert=require('node:assert/strict');process.env.SKIP_DB='true';process.env.JWT_SECRET='test';const app=require('../app');
test('Provider portal has separate frontend and API routes',()=>{assert.equal(typeof app,'function');assert.ok(require('../routes/frontend'));assert.ok(require('../routes/main'));});
test('shared models use named collection IDs',()=>{assert.ok(require('../models/LeadDistribution').schema.path('leadDistributionId'));assert.ok(require('../models/Provider').schema.path('providerId'));});
