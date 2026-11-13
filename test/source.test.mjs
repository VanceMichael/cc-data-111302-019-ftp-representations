import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {inspect,readRaw} from '../src/client.mjs';

async function withSource(callback){const source=await createSource();try{return await callback(source);}finally{await source.close();}}
function access(source){return async(path,options={})=>{const response=await fetch(source.url+path,{method:options.method||'GET',body:options.body===undefined?undefined:JSON.stringify(options.body),signal:AbortSignal.timeout(4000)});const text=await response.text();let value=text;try{value=JSON.parse(text);}catch{}return {status:response.status,value};};}
test('来源存活与单次目录读取',()=>withSource(async source=>{const api=access(source);assert.equal((await api('/health')).value.status,'ok');assert.ok(Object.keys(await inspect(source.url)).length>0);assert.ok((await readRaw(source.url,'/inventory')).length>0);}));
test('未知路径与坏控制请求明确拒绝',()=>withSource(async source=>{const api=access(source);assert.equal((await api('/missing')).status,404);const invalid=await fetch(source.url+'/control',{method:'POST',body:'not-json'});assert.equal(invalid.status,400);}));
test('来源领域契约的状态变化',()=>withSource(async source=>{const api=access(source);const {readBanner}=await import('../src/ftp-server.mjs');assert.match(await readBanner((await api('/state')).value.endpoint),/^220 /);await api('/control',{method:'POST',body:{finalFail:true}});assert.equal((await api('/state')).value.finalFail,true);}));


test('文本数据通道结束后仍保留最终失败',()=>withSource(async source=>{
  const net=await import('node:net');const {endpoint}=source.state;source.state.finalFail=true;
  const control=net.connect(endpoint.port,endpoint.host);let pending='';const replies=[];let notify;
  control.on('data',chunk=>{pending+=chunk;let boundary;while((boundary=pending.indexOf('\r\n'))>=0){replies.push(pending.slice(0,boundary));pending=pending.slice(boundary+2);if(notify){notify();notify=undefined;}}});
  async function reply(){const deadline=Date.now()+2000;while(!replies.length){if(Date.now()>deadline)throw new Error('FTP回复超时');await new Promise(resolve=>setTimeout(resolve,2));}return replies.shift();}
  try{
    assert.match(await reply(),/^220/);control.write('USER local\r\n');assert.match(await reply(),/^331/);control.write('PASS local\r\n');assert.match(await reply(),/^230/);control.write('TYPE A\r\n');assert.match(await reply(),/^200/);control.write('REST 2\r\n');assert.match(await reply(),/^504/);
    control.write('PASV\r\n');const passive=await reply();const numbers=passive.match(/\(([^)]+)\)/)[1].split(',').map(Number);const data=net.connect(numbers[4]*256+numbers[5],'127.0.0.1');const bytes=[];data.on('data',chunk=>bytes.push(chunk));const ended=new Promise(resolve=>data.on('end',resolve));
    control.write('RETR sample.txt\r\n');assert.match(await reply(),/^150/);await ended;assert.equal(Buffer.concat(bytes).toString(),'alpha\r\nbeta\r\n');assert.match(await reply(),/^451/);data.destroy();
  }finally{control.destroy();}
}));
