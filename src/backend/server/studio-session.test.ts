import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { sign, verify } from 'hono/jwt'
import { saveDb } from '../internal/model/db'
import { setUserPassword } from '../pkg/password'
import { authRouter, meHandler, studioSessionSeconds } from './auth'
import { revokeToken } from './middlewares'

test('ordinary members receive long sessions; administrators keep seven days and devices stay independent', async () => {
  const env:any={JWT_SECRET:'studio-session-fixture-secret',STUDIO_MEMBER_SESSION_DAYS:'180'}
  const users:any[]=[{id:1,username:'admin',role:2},{id:3,username:'member',role:0}]
  for(const u of users){Object.assign(u,{permission:8,base_path:'/素材',disabled:false});await setUserPassword(u,'fixture-password')}
  await saveDb({users,settings:[],storages:[],shares:[]},env,{force:true})
  const app=new Hono();app.route('/api/auth',authRouter);app.get('/api/me',meHandler)
  async function login(username:string){const r=await app.request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:'fixture-password'})},env);const j:any=await r.json();assert.equal(j.code,200);return j.data}
  const desktop=await login('member'),phone=await login('member'),admin=await login('admin')
  assert.notEqual(desktop.token,phone.token)
  const now=Math.floor(Date.now()/1000)
  assert.ok(Math.abs(desktop.expires_at-now-180*86400)<10)
  assert.ok(Math.abs(admin.expires_at-now-7*86400)<10)
  assert.equal((await verify(desktop.token,env.JWT_SECRET,'HS256')).exp,desktop.expires_at)
  const renewed=await app.request('/api/auth/refresh',{method:'POST',headers:{Authorization:desktop.token}},env)
  const j:any=await renewed.json();assert.equal(j.code,200);assert.notEqual(j.data.token,desktop.token)
  await revokeToken((await verify(j.data.token,env.JWT_SECRET,'HS256')).jti as string,j.data.expires_at,env)
  assert.equal((await app.request('/api/auth/refresh',{method:'POST',headers:{Authorization:j.data.token}},env)).status,401)
  assert.equal((await app.request('/api/me',{headers:{Authorization:phone.token}},env)).status,200)
  assert.equal((await app.request('/api/auth/refresh',{method:'POST',headers:{Authorization:admin.token}},env)).status,401)
})

test('refresh rejects absent, forged, expired, disabled and guest sessions', async () => {
  const env:any={JWT_SECRET:'studio-session-reject-secret',STUDIO_MEMBER_SESSION_DAYS:'180'}
  await saveDb({users:[{id:3,username:'disabled',role:0,disabled:true},{id:4,username:'guest',role:1,disabled:false}],settings:[],storages:[],shares:[]},env,{force:true})
  const app=new Hono();app.route('/api/auth',authRouter)
  const now=Math.floor(Date.now()/1000)
  const tokens=['','forged',await sign({id:3,exp:now+60},env.JWT_SECRET),await sign({id:4,exp:now+60},env.JWT_SECRET),await sign({id:3,exp:now-60},env.JWT_SECRET)]
  for(const token of tokens)assert.equal((await app.request('/api/auth/refresh',{method:'POST',headers:{Authorization:token}},env)).status,401)
  assert.equal(studioSessionSeconds({},0),7*86400)
  assert.equal(studioSessionSeconds({STUDIO_MEMBER_SESSION_DAYS:'9999'},0),7*86400)
})
