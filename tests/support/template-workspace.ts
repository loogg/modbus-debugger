import { emptyWorkspace, pointSchema, connectionSchema, type Workspace } from '../../src/domain/model';
import type { RawType } from '../../src/domain/mapping';
export function templateWorkspace(): Workspace {
  const point=(id:string,offset:number,rawType:RawType='Float32',extra={})=>pointSchema.parse({id,name:id,blockId:'b1',access:'rw',mapping:{rawType,offset,registerCount:rawType==='Float32'?2:1,wordOrder:'ABCD',byteSelector:'low',bitOffset:0,bitWidth:1,stringLength:0,stringEncoding:'ascii',...extra}});
  return {...emptyWorkspace(),connections:[connectionSchema.parse({id:'c1',name:'Connection',transport:'tcp',tcp:{host:'127.0.0.1',port:50123}})],
    templates:[{id:'t1',name:'模板 A',version:'1',description:'',blocks:[{id:'b1',name:'控制寄存器',area:3,start:0,length:40,periodMs:100},{id:'b2',name:'状态寄存器',area:3,start:100,length:4,periodMs:100}],points:[point('Ia',0),point('Ib',2),point('Flag',4,'Bool'),point('Mode',4,'BitField',{bitOffset:4,bitWidth:3}),point('High',4,'UInt8',{byteSelector:'high'}),point('Late',34,'String',{registerCount:3,stringLength:6}),{...point('Keep',0,'UInt16'),blockId:'b2'}]},
      {id:'t2',name:'模板 B',version:'1',description:'',blocks:[{id:'b1',name:'其他模板块',area:3,start:0,length:4,periodMs:100}],points:[point('Other',0)]}],
    slaves:[{id:'s1',connectionId:'c1',unitId:1,name:'A1',templateId:'t1',enabled:false},{id:'s2',connectionId:'c1',unitId:2,name:'A2',templateId:'t1',enabled:false},{id:'s3',connectionId:'c1',unitId:3,name:'B1',templateId:'t2',enabled:false}],
    trendGroups:[{id:'g1',name:'Trend',description:'',windowSec:60,signals:[['a','s1','Ia'],['b','s2','Ib'],['keep','s1','Keep'],['other','s3','Other']].map(([id,slaveId,pointId])=>({id:id!,visible:true,pointRef:{connectionId:'c1',slaveId:slaveId!,pointId:pointId!}}))}],
  };
}
