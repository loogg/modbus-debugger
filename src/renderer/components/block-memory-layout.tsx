import React, { useState } from 'react';
import type { BlockDef, PointDef } from '../../domain/model';
import { pointMemorySpan } from '../../domain/template-edit';
import { Button } from './ui';

export function BlockMemoryLayout({block,points,onSelect}:{block:BlockDef;points:PointDef[];onSelect:(pointId:string)=>void}) {
  const [page,setPage]=useState(0);
  const start=Math.min(page,Math.floor((block.length-1)/32))*32;
  const end=Math.min(block.length,start+32);
  const mapped=points.filter(p=>p.blockId===block.id).map(point=>({point,span:pointMemorySpan(block,point)}));
  return <section className="rounded-card border border-line bg-surface p-5" aria-label="点位内存布局">
    <h2 className="text-sm font-bold">点位内存布局</h2>
    <p className="mt-2 mb-4 text-xs text-ink2">按模板定义显示点位占用，不依赖设备连接。重叠映射分别列出；点击点位查看映射详情。</p>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({length:end-start},(_,i)=>i+start).map(offset=>{
        const occupants=mapped.filter(p=>offset>=p.span.start && offset<=p.span.end);
        return <div key={offset} data-testid={`memory-offset-${offset}`} className="min-w-0 rounded-ctl border border-line bg-surface2 p-3">
          <div className="mb-2 flex flex-wrap justify-between gap-1 text-xs text-ink2"><span className="mono">偏移 +{offset}</span><span>地址 {block.start+offset}</span></div>
          {!occupants.length && <span className="text-xs text-ink2">未映射</span>}
          {occupants.map(({point,span})=><button key={point.id} onClick={()=>onSelect(point.id)} className="focus-ring mb-2 block w-full rounded-ctl border border-line bg-surface p-2 text-left last:mb-0">
            <span className="block break-words text-sm font-medium text-accent">{point.name}</span>
            <span className="mt-1 block text-xs text-ink2">{point.mapping.rawType} · {span.width>1?`+${span.start}～+${span.end} · 第 ${offset-span.start+1}/${span.width} 寄存器`:block.area<=2?'1 位':`bit ${span.startBit}～${span.endBit}`}</span>
          </button>)}
        </div>;
      })}
    </div>
    {block.length>32 && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"><span>偏移 +{start}～+{end-1} / {block.length} {block.area<=2?'位':'寄存器'}</span><div className="flex gap-2"><Button disabled={start===0} onClick={()=>setPage(Math.max(0,page-1))}>上一页</Button><Button disabled={end===block.length} onClick={()=>setPage(Math.floor(start/32)+1)}>下一页</Button></div></div>}
  </section>;
}
