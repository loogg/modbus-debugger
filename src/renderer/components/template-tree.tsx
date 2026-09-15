import React, { useEffect, useState } from 'react';
import { ChevronDown20Regular, ChevronRight20Regular, Document20Regular } from '@fluentui/react-icons';
import type { DeviceTemplate } from '../../domain/model';

export function TemplateTree({templates,templateId,blockId,onTemplate,onBlock}:{templates:DeviceTemplate[];templateId:string|null;blockId:string|null;onTemplate:(id:string)=>void;onBlock:(templateId:string,blockId:string)=>void}) {
  const [collapsed,setCollapsed]=useState<Record<string,boolean>>({});
  useEffect(()=>{if(templateId && blockId)setCollapsed(old=>({...old,[templateId]:false}));},[templateId,blockId]);
  return <nav aria-label="设备模板树"><ul className="mt-4 space-y-2">
    {templates.map(template=><li key={template.id}>
      <div className={`flex items-start rounded-ctl ${templateId===template.id && !blockId?'bg-accentsoft':'bg-surface'}`}>
        <button className="focus-ring shrink-0 rounded-ctl p-2 mt-1" aria-label={`${collapsed[template.id]?'展开':'折叠'} ${template.name}`} aria-expanded={!collapsed[template.id]} onClick={()=>setCollapsed(old=>({...old,[template.id]:!old[template.id]}))}>{collapsed[template.id]?<ChevronRight20Regular/>:<ChevronDown20Regular/>}</button>
        <button className="focus-ring min-w-0 flex-1 rounded-ctl py-2.5 pr-2 text-left" aria-current={templateId===template.id&&!blockId?'page':undefined} onClick={()=>onTemplate(template.id)}><div className="break-words text-sm font-medium">{template.name}</div><div className="text-xs text-ink2 mt-0.5">{template.blocks.length} 个数据块 · {template.points.length} 个点位</div></button>
      </div>
      {!collapsed[template.id] && <ul className="ml-4 mt-1 space-y-1 border-l border-line pl-2">
        {template.blocks.map(block=><li key={block.id}><button aria-current={templateId===template.id&&blockId===block.id?'page':undefined} className={`focus-ring flex w-full items-start gap-1.5 rounded-ctl px-2 py-2 text-left text-xs ${templateId===template.id&&blockId===block.id?'bg-accentsoft text-accent':'hover:bg-surface'}`} onClick={()=>onBlock(template.id,block.id)}><Document20Regular className="shrink-0"/><span className="min-w-0 break-words">{block.name}<span className="mt-1 block text-ink2">{block.start}–{block.start+block.length-1}</span></span></button></li>)}
        {!template.blocks.length && <li className="px-2 py-2 text-xs text-ink2">暂无数据块</li>}
      </ul>}
    </li>)}
  </ul></nav>;
}
