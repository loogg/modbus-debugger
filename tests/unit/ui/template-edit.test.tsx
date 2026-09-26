import React from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { TemplatesSidebar } from '../../../src/renderer/shell';
import { TemplatesScreen } from '../../../src/renderer/screens/templates';
import { Overlays } from '../../../src/renderer/screens/overlays';
import { BlockMemoryLayout } from '../../../src/renderer/components/block-memory-layout';
import { useApp } from '../../../src/renderer/store/app';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import { templateWorkspace } from '../../support/template-workspace';
import type { Command } from '../../../src/shared/commands';
const calls=vi.fn();
beforeEach(()=>{calls.mockClear();useApp.setState({overlay:null,module:'templates',selection:{...useApp.getState().selection,templateId:'t1',templateEditing:false,editBlockId:null},command:async<T,>(cmd:Command)=>{calls(cmd);return {ok:true,value:null as T}},snapshot:{revision:1,workspace:templateWorkspace(),workspacePath:null,dirty:true,connections:{},blocks:{},points:{},transactions:[],parseEvents:[],diagRev:0,health:{},recording:null,sessions:[],warnings:[],prefs:DEFAULT_PREFS,historyDbPath:''}})});
afterEach(cleanup);
it('template links from other modules clear the previous block editing state',()=>{
  useApp.getState().select({templateId:'t1',templateEditing:true,editBlockId:'b1'});useApp.getState().select({templateId:'t2'});expect(useApp.getState().selection).toMatchObject({templateId:'t2',templateEditing:false,editBlockId:null});
});
it('navigates child blocks and returns to template overview, including after switching templates',()=>{
  render(<><TemplatesSidebar/><TemplatesScreen/></>);
  const tree=within(screen.getByRole('navigation',{name:'设备模板树'}));
  fireEvent.click(tree.getByRole('button',{name:/状态寄存器/}));expect(screen.getByRole('heading',{name:'状态寄存器'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:/返回设备模板/}));expect(screen.getByLabelText('模板名称')).toHaveValue('模板 A');
  fireEvent.click(tree.getByRole('button',{name:/控制寄存器/}));fireEvent.click(tree.getByRole('button',{name:/模板 B.*数据块/}));expect(screen.getByLabelText('模板名称')).toHaveValue('模板 B');
  fireEvent.click(tree.getByRole('button',{name:'折叠 模板 A'}));expect(tree.queryByRole('button',{name:/控制寄存器/})).toBeNull();
});
it('shows mappings without cache, includes overlaps and later offsets, and navigates to point detail',()=>{
  const t=templateWorkspace().templates[0]!;const onSelect=vi.fn();render(<BlockMemoryLayout block={t.blocks[0]!} points={t.points} onSelect={onSelect}/>);
  expect(screen.getByTestId('memory-offset-0')).toHaveTextContent('Ia');expect(screen.getByTestId('memory-offset-1')).toHaveTextContent('Ia');expect(screen.getByTestId('memory-offset-2')).toHaveTextContent('Ib');expect(screen.getByTestId('memory-offset-0')).not.toHaveTextContent('Ib');
  expect(screen.getByTestId('memory-offset-4')).toHaveTextContent('Flag');expect(screen.getByTestId('memory-offset-4')).toHaveTextContent('bit 4～6');expect(screen.getByTestId('memory-offset-4')).toHaveTextContent('bit 8～15');
  fireEvent.click(screen.getByRole('button',{name:'下一页'}));expect(screen.getByTestId('memory-offset-34')).toHaveTextContent('Late');fireEvent.click(within(screen.getByTestId('memory-offset-34')).getByRole('button'));expect(onSelect).toHaveBeenCalledWith('Late');
});
it('saves only through typed template persistence without invoking workspace export or a file dialog',async()=>{
  useApp.setState({selection:{...useApp.getState().selection,templateEditing:true,editBlockId:'b1'}});render(<TemplatesScreen/>);fireEvent.click(screen.getByRole('button',{name:'保存'}));expect(calls).toHaveBeenCalledWith({type:'template.save',templateId:'t1',blockId:'b1'});expect(calls.mock.calls.some(([cmd])=>cmd.type.startsWith('dialog.')||cmd.type==='workspace.saveAs')).toBe(false);
});
it('renames from the overview and only deletes a block after confirmation',()=>{
  render(<><TemplatesScreen/><Overlays/></>);fireEvent.change(screen.getByLabelText('模板名称'),{target:{value:'改名模板'}});fireEvent.click(screen.getByRole('button',{name:'保存模板名称'}));expect(calls).toHaveBeenCalledWith({type:'template.rename',templateId:'t1',name:'改名模板'});
  calls.mockClear();fireEvent.click(screen.getAllByRole('button',{name:'删除数据块'})[0]!);expect(screen.getByRole('dialog')).toHaveTextContent('6 个点位');fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(calls).not.toHaveBeenCalledWith(expect.objectContaining({type:'template.deleteBlock'}));
  fireEvent.click(screen.getAllByRole('button',{name:'删除数据块'})[0]!);fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'删除数据块'}));expect(calls).toHaveBeenCalledWith({type:'template.deleteBlock',templateId:'t1',blockId:'b1'});
});
it('configures point directly in the right inspector and saves through Main point command', async () => {
  useApp.setState({ selection: { ...useApp.getState().selection, templateEditing: true, editBlockId: 'b1' } });
  render(<><TemplatesScreen/><Overlays/></>);
  expect(screen.getByText('点位属性')).toBeTruthy();
  const nameInput = screen.getByDisplayValue('Ia');
  fireEvent.change(nameInput, { target: { value: 'Ia_Mod' } });
  fireEvent.click(screen.getByRole('button', { name: '保存点位' }));
  expect(calls).toHaveBeenCalledWith(expect.objectContaining({
    type: 'template.upsertPoint',
    templateId: 't1',
    point: expect.objectContaining({ name: 'Ia_Mod' }),
  }));
});
it('deletes point with confirmation dialog and calls template.deletePoint', async () => {
  useApp.setState({ selection: { ...useApp.getState().selection, templateEditing: true, editBlockId: 'b1' } });
  render(<><TemplatesScreen/><Overlays/></>);
  calls.mockClear();
  const delButtons = screen.getAllByRole('button', { name: '删除' });
  fireEvent.click(delButtons[0]!);
  expect(screen.getByRole('dialog')).toHaveTextContent('确定要删除点位');
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
  expect(calls).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'template.deletePoint' }));

  fireEvent.click(delButtons[0]!);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除点位' }));
  expect(calls).toHaveBeenCalledWith({ type: 'template.deletePoint', templateId: 't1', pointId: 'Ia' });
});
