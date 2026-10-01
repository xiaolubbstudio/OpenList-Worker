import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { consumeStudioRequest, studioLoginLock, recordStudioLogin, studioTrafficMiddleware } from './studio-traffic'
function binding(sql: DatabaseSync) { return { prepare(query: string) { let args: any[]=[]; const s={bind(...values:any[]){args=values;return s},async run(){const r=sql.prepare(query).run(...args);return {success:true,meta:{changes:r.changes}}},async first(){return sql.prepare(query).get(...args)||null}}; return s } } }
test('member limit persists across instances, separates members sharing one IP and resets after the minute', async()=>{
 const sql=new DatabaseSync(':memory:'),a:any={DB:binding(sql),STUDIO_API_PER_MINUTE:'300'},b:any={DB:binding(sql),STUDIO_API_PER_MINUTE:'300'},now=1000000
 for(let i=0;i<300;i++)assert.equal((await consumeStudioRequest(i%2?a:b,11,now)).allowed,true)
 assert.deepEqual(await consumeStudioRequest(b,11,now),{allowed:false,retryAfter:60})
 assert.equal((await consumeStudioRequest(b,12,now)).allowed,true)
 assert.equal((await consumeStudioRequest(a,11,now+60000)).allowed,true)
 sql.close()
})
test('five failed logins lock the same account across instances for 15 minutes; successful login resets consecutive failures',async()=>{
 const sql=new DatabaseSync(':memory:'),a:any={DB:binding(sql)},b:any={DB:binding(sql)},now=1000000
 const {key}=await studioLoginLock(a,'Member-One',now)
 for(let i=0;i<4;i++)await recordStudioLogin(i%2?a:b,key,false,now)
 assert.equal((await studioLoginLock(b,'member-one',now)).retryAfter,0)
 await recordStudioLogin(b,key,true,now)
 for(let i=0;i<5;i++)await recordStudioLogin(a,key,false,now)
 assert.equal((await studioLoginLock(b,'MEMBER-ONE',now)).retryAfter,900)
 assert.equal((await studioLoginLock(b,'other-member',now)).retryAfter,0)
 assert.equal((await studioLoginLock(b,'member-one',now+900000)).retryAfter,0)
 sql.close()
})
test('middleware returns 429 and Retry-After without calling the protected handler, and ignores forged user claims',async()=>{
 const sql=new DatabaseSync(':memory:'),env:any={DB:binding(sql),STUDIO_API_PER_MINUTE:'1',JWT_SECRET:'studio-traffic-test-secret-at-least-32'},app=new Hono();let calls=0
 app.use('/api/*',studioTrafficMiddleware);app.get('/api/test',c=>{calls++;return c.json({code:200,data:null})})
 const token=await sign({id:11,exp:Math.floor(Date.now()/1000)+600},env.JWT_SECRET)
 assert.equal((await app.request('/api/test',{headers:{Authorization:token}},env)).status,200)
 const denied=await app.request('/api/test',{headers:{Authorization:token}},env)
 assert.equal(denied.status,429);assert.equal(denied.headers.get('Retry-After'),'60');assert.equal(calls,1)
 const another=await sign({id:12,exp:Math.floor(Date.now()/1000)+600},env.JWT_SECRET)
 assert.equal((await app.request('/api/test',{headers:{Authorization:another,'CF-Connecting-IP':'same-ip'}},env)).status,200)
 assert.equal((await app.request('/api/test',{headers:{Authorization:'forged.invalid.token'}},env)).status,200)
 assert.equal(sql.prepare("SELECT count(*) AS n FROM studio_request_limits WHERE key LIKE 'user:%'").get()?.n,2)
 sql.close()
})
test('database failure refuses authenticated API work instead of silently dropping the limiter',async()=>{
 const env:any={STUDIO_API_PER_MINUTE:'300',JWT_SECRET:'studio-traffic-test-secret-at-least-32',DB:{prepare(){throw Error('offline')}}};let calls=0;const app=new Hono();app.use('/api/*',studioTrafficMiddleware);app.get('/api/test',c=>{calls++;return c.json({code:200})});const token=await sign({id:11,exp:Math.floor(Date.now()/1000)+600},env.JWT_SECRET)
 assert.equal((await app.request('/api/test',{headers:{Authorization:token}},env)).status,503);assert.equal(calls,0)
})
