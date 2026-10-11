import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { resolveClip, limitedBytes, clipKey, CLIP_DIRECTORY } from './studio-preview-clip'
function database(sql: DatabaseSync) {
  return { prepare(query: string) { let args: any[] = []; const s = { bind(...v: any[]) {args=v;return s},async run(){return {meta:{changes:Number(sql.prepare(query).run(...args).changes)}}},async first(){return sql.prepare(query).get(...args)||null}};return s }, async batch(statements:any[]){for(const s of statements) await s.run()} }
}
test('five-second derivative is generated once, shared, and never returns an original URL; source versions and concurrent requests stay isolated', async()=>{
  const sql = new DatabaseSync(':memory:'), db=database(sql), originalFetch=globalThis.fetch
  let transforms=0, uploads=0, sourceReads=0, clipReads=0, started!:()=>void, finish!:()=>void
  const inputSeen=new Promise<void>(r=>{started=r}), gate=new Promise<void>(r=>{finish=r})
  const row={id:'one',uid:'source-uid',name:'短视频.mov',source_path:'/素材/短视频.mov',size:32,modified:'2026-10-11'}
  let output:{name:string,size:number}|null=null
  const driver={async get(_v:string,p:string){if(p.endsWith('.mov')){sourceReads++;return{sign:row.uid,size:row.size,raw_url:'https://download.yun.139.com/original.mov'}}clipReads++;return{sign:'clip-uid',size:24,raw_url:'https://download.yun.139.com/preview.mp4'}},async studioEnsureDirectory(p:string){assert.equal(p,'/'+CLIP_DIRECTORY)},async beginStudioUpload(_p:string,name:string,size:number){uploads++;output={name,size};return{fileId:'clip-uid',ready:true}},async finishStudioUpload(){return output}}
  const ctx={scope:'/素材',db,c:{env:{MEDIA:{input(body:ReadableStream){assert.ok(body);return{transform(options:any){assert.deepEqual(options,{width:640,height:360,fit:'scale-down'});return{output(options:any){assert.deepEqual(options,{mode:'video',time:'0s',duration:'5s',audio:true});return{async response(){transforms++;started();await gate;return new Response(new Uint8Array(24),{headers:{'Content-Type':'video/mp4'}})}}}}}}}}}}}
  const target=async(_c:any,p:string)=>({driver,resolved:{physical:p.replace('/素材','')}}),flush=async()=>{}
  globalThis.fetch=async(input:any)=>{assert.equal(String(input),'https://download.yun.139.com/original.mov');return new Response(new Uint8Array(32))}
  try{
    const job=resolveClip(ctx,row,target,flush);await inputSeen
    await assert.rejects(resolveClip(ctx,row,target,flush),(e:any)=>e.code===409)
    finish();const clip=await job
    assert.equal(clip.duration,5);assert.equal(clip.profile,'360p-5s-v1');assert.match(clip.preview_url,/preview\.mp4$/);assert.ok(!JSON.stringify(clip).includes('original'))
    assert.deepEqual(await resolveClip(ctx,{...row,name:'重命名.mov',folder:'新目录'},target,flush),clip)
    assert.equal(transforms,1);assert.equal(uploads,1);assert.equal(sourceReads,1);assert.equal(clipReads,2)
    assert.equal(sql.prepare('SELECT seconds FROM studio_preview_budget').get()!.seconds,5)
    assert.notEqual(await clipKey(ctx.scope,row),await clipKey(ctx.scope,{...row,modified:'new'}))
    assert.equal(sql.prepare('SELECT file_path FROM studio_preview_clips').get()!.file_path,String('/素材/'+CLIP_DIRECTORY+'/'+output!.name))
  }finally{globalThis.fetch=originalFetch;sql.close()}
})
test('oversized originals, incompatible conversions and exhausted budgets do not fall back to original playback or keep converting', async()=>{
  const sql=new DatabaseSync(':memory:'),db=database(sql),originalFetch=globalThis.fetch
  const row={id:'bad',uid:'source',name:'素材.mov',source_path:'/素材/素材.mov',size:32,modified:'now'}
  let fetches=0,transforms=0
  const ctx={scope:'/素材',db,c:{env:{MEDIA:{input(){return{transform(){return{output(){return{async response(){transforms++;const error:any=new Error('signed URL must not escape');error.name='MediaError';error.code=9402;throw error}}}}}}}}}}}
  const target=async()=>({resolved:{physical:'/素材.mov'},driver:{async get(){return{size:row.size,sign:row.uid,raw_url:'https://download.yun.139.com/original.mov'}}}})
  globalThis.fetch=async()=>{fetches++;return new Response(new Uint8Array(32))}
  try{
    await assert.rejects(resolveClip(ctx,{...row,size:100000000},target,async()=>{}),(e:any)=>e.code===413)
    assert.equal(fetches,0)
    await assert.rejects(resolveClip(ctx,row,target,async()=>{}),(e:any)=>e.code===415&&!e.message.includes('signed'))
    await assert.rejects(resolveClip(ctx,row,target,async()=>{}),(e:any)=>e.code===415)
    assert.equal(transforms,1);assert.equal(fetches,1)
    sql.prepare('UPDATE studio_preview_budget SET seconds=4000').run()
    await assert.rejects(resolveClip(ctx,{...row,id:'another'},target,async()=>{}),(e:any)=>e.code===429)
    assert.equal(fetches,1,'exhausted budget never fetches an original')
    assert.equal(sql.prepare('SELECT seconds FROM studio_preview_budget').get()!.seconds,4000)
    await assert.rejects(limitedBytes(new Response(new Uint8Array(5)),4),(e:any)=>e.code===413)
  }finally{globalThis.fetch=originalFetch;sql.close()}
})
