import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/app';
import { Button, TextInput } from './ui';
import { useDirtyGuard } from '../workbench/view-context';

export function TemplateProperties({templateId,name}:{templateId:string;name:string}) {
  const command=useApp(s=>s.command);const toast=useApp(s=>s.toast);
  const [draft,setDraft]=useState(name);const [saving,setSaving]=useState(false);
  const [base, setBase] = useState(name);
  const dirty = draft !== base;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useDirtyGuard(dirty);
  useEffect(() => { if (!dirtyRef.current) { setDraft(name); setBase(name); } }, [name]);
  const save=async()=>{setSaving(true);try {if(!(await command({type:'template.rename',templateId,name:draft.trim(),expectedName:base})).ok)return;setBase(draft.trim());setDraft(draft.trim());if((await command({type:'template.save',templateId})).ok)toast({kind:'success',title:'模板名称已保存'});}finally{setSaving(false)}};
  return <form onSubmit={event=>{event.preventDefault();void save();}} className="mb-5 flex max-w-xl flex-wrap items-end gap-3">
    <label className="min-w-0 flex-1"><span className="mb-1.5 block text-xs text-ink2">模板名称</span><TextInput value={draft} maxLength={200} onChange={e=>setDraft(e.target.value)} disabled={saving}/></label>
    <Button type="submit" disabled={saving||!draft.trim()||!dirty}>保存模板名称</Button>
    {dirty && name !== base && <div role="alert" className="w-full text-xs text-warn">模板名称已被其他页面修改，当前草稿已保留。<button type="button" className="ml-2 text-accent" onClick={() => { setDraft(name); setBase(name); }}>重新载入</button></div>}
  </form>;
}
