// Delft3D NEFIS paired-file reference-time adjustment. Layout reference: Deltares QUICKPLOT vs_use.m / vs_let.m / d3d_trihfil.m / d3d_trimfil.m. Changes only existing time metadata, never water-level or time-step payloads.
export async function planNefis(dat,def,kind){
 const check=(ok,msg)=>{if(!ok)throw Error(msg)};
 const v=b=>new DataView(b.buffer,b.byteOffset,b.byteLength);
 const str=(b,p,n)=>String.fromCharCode(...b.subarray(p,p+n)).replace(/[\x00 ]+$/g,"");
 async function rd(f,p,n){check(Number.isSafeInteger(p)&&Number.isSafeInteger(n)&&p>=0&&n>=0&&p+n<=f.size,"NEFIS address outside file");const b=await f.read(p,n);check(b.length===n,"Incomplete read");return b}
 async function fmt(f,label){
  const b=await rd(f,0,68),h=str(b,0,59),flag=String.fromCharCode(b[59]);
  check(/NEFIS/i.test(h)&&(label==="data"?/Data File/i.test(h):/Definition File|DEFN FILE/i.test(h)),"Not a paired NEFIS "+label+" file");
  const w=/(?:Version\s*|File;\s*)5\./i.test(h)?8:/Version\s*4\.|Versie\s*1\./i.test(h)?4:0;
  check(w,"Unsupported NEFIS version");
  const opts=w===8?(flag==="L"?[true]:flag==="B"?[false]:[]):flag==="N"?[false]:[true,false];
  const matches=opts.filter(l=>w===8?v(b).getBigUint64(60,l)===BigInt(f.size):v(b).getUint32(60,l)===f.size);
  check(matches.length===1,"Invalid endian or file length; close FLOW before conversion");
  return {w,l:matches[0]};
 }
 check(["trih","trim"].includes(kind),"Unsupported result kind");
 const a=await fmt(dat,"data"),b=await fmt(def,"definition");
 check(a.w===b.w&&a.l===b.l,"Data and definition formats differ");
 const {w,l}=a,head=60+w,nameAt=3*w,minData=head+997*w,minDef=head+2991*w;
 function ptr(b,p){if(w===4){const x=v(b).getUint32(p,l);return x===0xffffffff?null:x}const x=v(b).getBigUint64(p,l);if(x===0xffffffffffffffffn)return null;check(x<=BigInt(Number.MAX_SAFE_INTEGER),"Offset exceeds safe integer");return Number(x)}
 const u=(b,p)=>v(b).getUint32(p,l);
 async function records(f,t,types){
  const hash=await rd(f,head+t*997*w,997*w),out=new Map(),seen=new Set(),min=f===dat?minData:minDef;
  for(let i=0;i<997;i++){let p=ptr(hash,i*w);while(p!==null){
   check(p>=min&&!seen.has(p)&&seen.size<100000,"Invalid or cyclic hash link");seen.add(p);
   const r=await rd(f,p,nameAt+16),next=ptr(r,0),size=ptr(r,w),type=str(r,2*w,w).trim(),name=str(r,nameAt,16);
   check(types.includes(type)&&size!==null&&size>=r.length&&p+size<=f.size&&name&&!out.has(name),"Invalid NEFIS record: "+name);
   out.set(name,{p,size,type});p=next;
  }}return out;
 }
 const [dg,g,c,e]=await Promise.all([records(dat,0,["4","5"]),records(def,2,["3"]),records(def,1,["2"]),records(def,0,["1"])]);
 const gn=kind==="trih"?"his-const":"map-const",group=dg.get(gn);check(group,"Missing "+gn);
 const names=await rd(dat,group.p+nameAt,32),gd=g.get(str(names,16,16));check(gd&&gd.size>=nameAt+60,"Missing group definition");
 const gr=await rd(def,gd.p,nameAt+60),cell=c.get(str(gr,nameAt+16,16));check(cell,"Missing cell");
 const dim=u(gr,nameAt+36);check(u(gr,nameAt+32)===1&&u(gr,nameAt+56)===1&&((group.type==="4"&&dim===1)||(group.type==="5"&&dim===0)),"Unsupported constant group dimensions");
 const ls=nameAt+20+w,ch=await rd(def,cell.p,ls),cs=ptr(ch,nameAt+16),n=u(ch,nameAt+16+w);
 check(cs!==null&&cs>0&&n>0&&n<=10000&&ls+16*n<=cell.size+2*w,"Invalid cell list");
 const cr=await rd(def,cell.p+ls,16*n);
 const fields=new Map();let off=0;
 for(let i=0;i<n;i++){const name=str(cr,16*i,16),el=e.get(name);check(el&&!fields.has(name)&&el.size>=nameAt+24+w+4,"Missing or duplicate element "+name);const er=await rd(def,el.p,nameAt+24+w+4),type=str(er,nameAt+16,8),bytes=ptr(er,nameAt+24),unit=u(er,nameAt+24+w);check(bytes!==null&&bytes>0&&off+bytes<=cs,"Invalid element size "+name);fields.set(name,{off,type,bytes,unit});off+=bytes}
 check(off===cs||Math.ceil(off/4)*4===cs,"Cell size mismatch");
 const hdr=392+3*w;let base=group.p+hdr;
 if(group.type==="5"){
  const block=ptr(await rd(dat,base,w),0);check(block===cs||block===Math.ceil(cs/4)*4,"Group size mismatch");base+=w;
  for(let depth=3;depth>=0;depth--){check(base>=minData,"Invalid constant record pointer");const tbl=await rd(dat,base,256*w),index=depth===0?1:0;let count=0;for(let j=0;j<256;j++)if(ptr(tbl,j*w)!==null)count++;check(count===1&&ptr(tbl,index*w)!==null,"Expected exactly one constant record");base=ptr(tbl,index*w)}
 }else check(group.size-hdr===cs||group.size-hdr===Math.ceil(cs/4)*4,"Fixed group size mismatch");
 check(base>=minData&&base+cs<=dat.size,"Invalid constant data location");
 const it=fields.get("ITDATE");check(it&&it.type==="INTEGER"&&it.unit===4&&it.bytes===8,"Expected ITDATE[2] int32");
 const old=await rd(dat,base+it.off,8),date=v(old).getInt32(0,l),time=v(old).getInt32(4,l),y=Math.floor(date/10000),m=Math.floor(date/100)%100,d=date%100,dt=new Date(Date.UTC(y,m-1,d));
 check(y>=1900&&y<=9999&&dt.getUTCFullYear()===y&&dt.getUTCMonth()===m-1&&dt.getUTCDate()===d,"Invalid reference date");
 let tzValue=null,tzPatch=null;const tz=fields.get("TZONE");
 if(tz){check(tz.type==="REAL"&&tz.unit===tz.bytes&&[4,8].includes(tz.unit),"Unsupported TZONE type");const before=await rd(dat,base+tz.off,tz.bytes),after=new Uint8Array(tz.bytes);if(tz.bytes===4){tzValue=v(before).getFloat32(0,l);v(after).setFloat32(0,9,l)}else{tzValue=v(before).getFloat64(0,l);v(after).setFloat64(0,9,l)}tzPatch={at:base+tz.off,before,after,field:"TZONE"}}
 const meta={date,time,tzValue,version:w===8?5:4,endian:l?"LE":"BE"};
 if(time===90000&&(tzValue===null||tzValue===9))return {...meta,already:true,patches:[]};
 check(time===0,"Reference clock not 00:00:00; only UTC-midnight references supported");
 check(tzValue===null||tzValue===0,"TZONE is not zero");
 const after=new Uint8Array(4);v(after).setInt32(0,90000,l);
 return {...meta,already:false,patches:[{at:base+it.off+4,before:old.slice(4),after,field:"ITDATE[2]"},...(tzPatch?[tzPatch]:[])]};
}
