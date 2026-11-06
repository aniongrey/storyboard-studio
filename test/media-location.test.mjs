import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createStudio } from '../server/main.mjs';
import { revealMediaFile } from '../server/media.mjs';

test('reveal launches Explorer without a shell and reports launch failure', async () => {
  const file='C:\\作品 文件\\镜头,1.png';
  let unreferenced=false;
  await revealMediaFile(file,(command,args,options)=>{
    assert.equal(command,'explorer.exe');
    assert.deepEqual(args,[`/select,${file}`]);
    assert.equal(options.shell,false);
    assert.equal(options.windowsHide,true);
    assert.ok(Object.keys(options.env).every(name=>!/key|token|secret|password|credential|authorization/i.test(name)));
    const child=new EventEmitter();child.unref=()=>{unreferenced=true;};
    queueMicrotask(()=>child.emit('spawn'));
    return child;
  });
  assert.ok(unreferenced);
  await assert.rejects(revealMediaFile(file,()=>{
    const child=new EventEmitter();
    queueMicrotask(()=>child.emit('error',new Error('ENOENT')));
    return child;
  }),/无法打开资源管理器/);
});

test('media reveal requires CSRF and only opens an existing registered file within data', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'studio-reveal-'));
  const opened=[];
  const studio=createStudio({dataDir,revealMediaFileImpl:async file=>opened.push(file),generationOptions:{getRunningHubKey:()=>null,inspectCodexImpl:async()=>({available:false})}});
  const server=studio.app.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    const project=studio.store.state().project,owner=project.assets[0];
    const file='作品 文件/参考图,1.png';
    await mkdir(join(dataDir,'作品 文件'));
    await writeFile(join(dataDir,file),'mock media bytes');
    const add=file=>studio.store.addMedia(project.id,owner.id,{file,kind:'image',mime:'image/png',sha256:'mock',baseVersion:owner.currentVersion});
    const media=add(file);
    const headers={'Content-Type':'application/json','X-Studio-Token':studio.csrfToken};
    const request=(id,headers={},body='{}')=>fetch(`${base}/api/media/${id}/reveal`,{method:'POST',headers,body});
    assert.equal((await request(media.id)).status,403);
    const response=await request(media.id,headers,JSON.stringify({path:'../outside.png'}));
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{opened:true});
    assert.deepEqual(opened,[await realpath(join(dataDir,file))]);
    assert.equal((await request(add('missing.png').id,headers)).status,404);
    assert.throws(()=>add('../outside.png'),/媒体路径必须位于 data/);
    assert.equal((await request(add('作品 文件').id,headers)).status,404);
    assert.equal((await request('unknown-media',headers)).status,404);
    assert.equal(opened.length,1);
  } finally {
    await new Promise(resolve=>server.close(resolve));studio.close();
    await rm(dataDir,{recursive:true,force:true});
  }
});

test('image video and audio cards each reveal their own registered media ID', async () => {
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const node=(tag,attrs={},...children)=>({tag,attrs,children:children.flat().filter(Boolean),append(...items){this.children.push(...items.flat());}});
  const walk=tree=>typeof tree==='object'?[tree,...tree.children.flatMap(walk)]:[];
  const requests=[];
  const context={node,button:(label,onClick)=>node('button',{onClick},label),mediaElement:()=>null,mediaCaption:()=>null,isAdopted:()=>false,badge:()=>null,date:()=>'',mediaUrl:m=>`/api/media/${m.id}`,perform:action=>action(),api:async(url,options)=>requests.push({url,options})};
  runInNewContext(app.slice(app.indexOf('function renderMedia('),app.indexOf('async function uploadMedia(')),context);
  const container=node('div');
  context.renderMedia(container,{media:['image','video','audio'].map(kind=>({id:`media-${kind}`,kind}))});
  const buttons=walk(container).filter(e=>e.tag==='button'&&e.children.includes('打开本地文件位置'));
  assert.equal(buttons.length,3);
  for(const button of buttons)await button.attrs.onClick();
  assert.deepEqual(requests.map(r=>r.url).sort(),['audio','image','video'].map(kind=>`/api/media/media-${kind}/reveal`));
  assert.ok(requests.every(r=>r.options.method==='POST'));
});
