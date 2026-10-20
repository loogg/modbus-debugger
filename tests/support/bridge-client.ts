import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { BridgeServerMessage } from '../../src/shared/preload-api';

export async function connectBridge(port:number, options:{origin?:string;protocol?:string} = {}) {
  const messages:BridgeServerMessage[]=[];
  const events=new EventEmitter();
  let socket:Socket|undefined;
  let buffer=Buffer.alloc(0);
  const consume=(chunk:Buffer)=>{
    buffer=Buffer.concat([buffer,chunk]);
    while(buffer.length>=2) {
      let length=buffer[1]!&127,offset=2;
      if(length===126){if(buffer.length<4)return;length=buffer.readUInt16BE(2);offset=4;}
      if(length===127){if(buffer.length<10)return;length=Number(buffer.readBigUInt64BE(2));offset=10;}
      if(buffer.length<offset+length)return;
      const opcode=buffer[0]!&15;
      const payload=buffer.subarray(offset,offset+length);buffer=buffer.subarray(offset+length);
      if(opcode===1){const message=JSON.parse(payload.toString()) as BridgeServerMessage;messages.push(message);events.emit('message',message);}
    }
  };
  const status=await new Promise<number>((resolve,reject)=>{
    const request=http.request({host:'127.0.0.1',port,path:'/',headers:{
      Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64'),
      ...(options.origin?{Origin:options.origin}:{}),...(options.protocol?{'Sec-WebSocket-Protocol':options.protocol}:{}),
    }});
    request.setTimeout(3000,()=>request.destroy(new Error('Bridge handshake timeout')));
    request.on('error',reject);
    request.on('response',response=>{response.resume();resolve(response.statusCode!);});
    request.on('upgrade',(response,connection,head)=>{
      socket=connection;socket.on('error',()=>{});socket.on('data',consume);consume(head);resolve(response.statusCode!);
    });
    request.end();
  });
  return {
    status,messages,
    send(value:unknown) {
      const payload=Buffer.from(JSON.stringify(value));
      const mask=crypto.randomBytes(4),header=Buffer.alloc(payload.length<126?2:4);
      header[0]=0x81;header[1]=0x80|(payload.length<126?payload.length:126);
      if(payload.length>=126)header.writeUInt16BE(payload.length,2);
      for(let index=0;index<payload.length;index++)payload[index]=payload[index]!^mask[index%4]!;
      socket!.write(Buffer.concat([header,mask,payload]));
    },
    async waitFor(predicate:(message:BridgeServerMessage)=>boolean):Promise<BridgeServerMessage>{
      const existing=messages.find(predicate);if(existing)return existing;
      return new Promise((resolve,reject)=>{
        const finish=(message:BridgeServerMessage)=>{if(predicate(message)){clearTimeout(timer);events.off('message',finish);resolve(message);}};
        const timer=setTimeout(()=>{events.off('message',finish);reject(new Error('Bridge message timeout'));},3000);
        events.on('message',finish);
      });
    },
    close(){socket?.destroy();},
  };
}
