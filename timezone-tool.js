import {planNefis} from './nefis-time.js';
const $=id=>document.getElementById(id);
for(const name of ['track','zone']) $(name+'-tab').onclick=()=>{for(const n of ['track','zone']){$(n+'-tab').setAttribute('aria-selected',String(n===name));$(n+'-page').hidden=n!==name;}};
let dir=null, busy=false;
const status=s=>$('zone-status').textContent=s;
const log=s=>{$('zone-log').textContent+=s+'\n';};
function buttons(){$('zone-pick').disabled=busy;$('zone-confirm').disabled=busy;$('zone-run').disabled=busy||!dir||!$('zone-confirm').checked;}
$('zone-confirm').onchange=buttons;
const wrap=f=>({size:f.size,read:async(p,n)=>new Uint8Array(await f.slice(p,p+n).arrayBuffer())});
const equal=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
async function copy(file,handle){const w=await handle.createWritable();try{await file.stream().pipeTo(w);}catch(e){try{await w.abort()}catch{}throw e;}}
$('zone-pick').onclick=async()=>{
 if(!window.showDirectoryPicker){status('Direct folder editing requires Chrome or Edge. Firefox is not supported.');return;}
 try{dir=await window.showDirectoryPicker({mode:'readwrite'});$('zone-folder').textContent=dir.name;$('zone-confirm').checked=false;status('Folder selected. Confirm UTC and close FLOW/QUICKPLOT before conversion.');}catch(e){status(e.message);}buttons();
};
$('zone-run').onclick=async()=>{
 if(!dir||busy||!$('zone-confirm').checked)return;
 busy=true;buttons();$('zone-log').textContent='';let backup=null;const committed=[];
 try{
  status('Validating all result pairs…');
  const files=new Map();for await(const [name,h] of dir.entries())if(h.kind==='file')files.set(name.toLowerCase(),h);
  const plans=[];
  for(const [name,h] of files){
   if(!/^(trih|trim)-.+\.dat$/i.test(name))continue;
   const dh=files.get(name.slice(0,-4)+'.def');if(!dh)throw Error('Missing definition: '+h.name);
   const f=await h.getFile(),d=await dh.getFile();
   const plan=await planNefis(wrap(f),wrap(d),name.slice(0,4));
   log(h.name+': NEFIS v'+plan.version+' '+plan.endian+' — '+(plan.already?'already KST; skipped':plan.date+' 00:00 → 09:00'));
   if(!plan.already)plans.push({h,dh,f,d,plan});
  }
  if(!plans.length){status('No unconverted supported result pairs found.');return;}
  const bn='_UTC_backup_'+new Date().toISOString().replace(/[:.]/g,'-');
  backup=await dir.getDirectoryHandle(bn,{create:true});
  status('Backing up '+plans.length+' result pairs…');
  for(const p of plans){await copy(p.f,await backup.getFileHandle(p.h.name,{create:true}));await copy(p.d,await backup.getFileHandle(p.dh.name,{create:true}));}
  log('UTC backups saved: '+bn);
  status('Updating original files…');
  for(const p of plans){
   const now=await p.h.getFile(),def=await p.dh.getFile();
   if(now.size!==p.f.size||now.lastModified!==p.f.lastModified||def.size!==p.d.size||def.lastModified!==p.d.lastModified)throw Error('File changed since scan: '+p.h.name);
   for(const x of p.plan.patches)if(!equal(await wrap(now).read(x.at,x.before.length),x.before))throw Error('Time bytes changed: '+p.h.name);
   const w=await p.h.createWritable({keepExistingData:true});
   try{for(const x of p.plan.patches)await w.write({type:'write',position:x.at,data:x.after});await w.close();}catch(e){try{await w.abort()}catch{}throw e;}
   committed.push(p);
   const verify=await planNefis(wrap(await p.h.getFile()),wrap(def),p.h.name.toLowerCase().slice(0,4));
   if(!verify.already)throw Error('Verification failed: '+p.h.name);
   log(p.h.name+': converted and verified');
  }
  status('Done: '+committed.length+' files updated in place. Reopen in QUICKPLOT. Backup: '+bn);
 }catch(e){
  log('ERROR: '+e.message);
  if(backup&&committed.length){status('Error; restoring modified files…');for(const p of committed){try{await copy(await (await backup.getFileHandle(p.h.name)).getFile(),p.h);log('Restored '+p.h.name);}catch(err){log('RESTORE FAILED: '+p.h.name+' — restore manually from backup. '+err.message);}}}
  status('Conversion stopped. Check log and backup before retrying.');
 }finally{busy=false;$('zone-confirm').checked=false;buttons();}
};
buttons();
