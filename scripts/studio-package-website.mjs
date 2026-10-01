import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['index.html','styles.css','workspace.css','brand.css','dark.css','dock.css','motion.css','fluent.css','app.js','motion.js','preview-cache.js','pcloud-auth.js','auth-callback.js','pcloud-client.js','google-drive-client.js','google-drive-auth.js','openlist-client.js','openlist-auth.js','upload-drop.js','auth.html','data/catalog.js']
const assets = ['orange.svg','sunset.svg','landscape.svg','orbit.svg','chime.wav','studio-face.png','ui-icons.svg','Phosphor-LICENSE.txt','surface-grain.svg']
const source = process.env.STUDIO_WEBSITE_DIR ? path.resolve(process.env.STUDIO_WEBSITE_DIR) : path.resolve(root,'../..')
const local = await fs.stat(path.join(source,'index.html')).then(s=>s.isFile()).catch(()=>false)
const destination = path.join(root,'dist/studio')
await fs.mkdir(destination,{recursive:true})
for (const name of [...files,...assets.map(name=>'assets/'+name)]) {
  let data
  if(local) data=await fs.readFile(path.join(source,name))
  else {
    const response=await fetch('https://raw.githubusercontent.com/xiaolubbstudio/xczstudio/main/'+name,{signal:AbortSignal.timeout(30000)})
    if(!response.ok) throw Error('Website file unavailable: '+name)
    data=Buffer.from(await response.arrayBuffer())
  }
  await fs.mkdir(path.dirname(path.join(destination,name)),{recursive:true})
  await fs.writeFile(path.join(destination,name),data)
}
await fs.writeFile(path.join(root,'dist/_headers'), `/studio/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; media-src 'self' blob: https:; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
/studio/
  Cache-Control: no-cache
/studio/index.html
  Cache-Control: no-cache
`)
console.log('Packaged the studio website at /studio/; only whitelisted public website files were included.')
