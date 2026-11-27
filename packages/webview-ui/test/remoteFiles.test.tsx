// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { WorkbenchRightPanel } from '../src/components/workbench/WorkbenchRightPanel.tsx';
import { applyHostMessage, resetStoreForTests, setRightPanelOpen, setRightPanelTab } from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();

beforeEach(() => {
  vscode.reset();
  resetStoreForTests();
});

describe('工作区文件面板（本地与远端存储）', () => {
  it('支持添加远端存储弹窗（含标题问号指引），以及本地上传、新建目录与删除二次确认', () => {
    render(<WorkbenchRightPanel />);
    act(() => {
      setRightPanelOpen(true);
      setRightPanelTab('files');
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          remoteStorages: {
            items: [
              {
                id: 'gcs-1',
                name: 'Google Cloud Bucket',
                kind: 'google-cloud-storage',
                bucket: 'my-bucket',
                hasSecret: true,
                createdAt: 1,
              },
            ],
          },
        }),
      });
    });
    const searchMsg = vscode.posted.find((m) => m.type === 'searchFiles');
    const searchReqId = searchMsg && searchMsg.type === 'searchFiles' ? searchMsg.payload.requestId : 1;
    act(() => {
      applyHostMessage({
        type: 'fileCandidates',
        payload: {
          requestId: searchReqId,
          items: [{ path: 'README.md', kind: 'file' }],
        },
      });
    });
    vscode.posted.length = 0;

    // 1. 打开添加远端存储弹窗，先展示带品牌图标的厂商卡片
    fireEvent.click(screen.getByTestId('right-panel-files-add-storage'));
    expect(screen.getByTestId('remote-storage-dialog')).toBeTruthy();
    expect(screen.getByTestId('remote-storage-vendor-cards')).toBeTruthy();
    expect(screen.getByTestId('remote-storage-card-google-drive')).toBeTruthy();
    expect(screen.getByTestId('remote-storage-card-google-cloud-storage')).toBeTruthy();
    expect(screen.getByTestId('remote-storage-card-webdav')).toBeTruthy();

    fireEvent.click(screen.getByTestId('remote-storage-guide-toggle'));
    expect(screen.getByTestId('remote-storage-guide-popover')).toBeTruthy();

    // 选择 Google Cloud Storage 卡片 → 支持一键跳转浏览器授权，也支持展开高级手动凭据
    fireEvent.click(screen.getByTestId('remote-storage-card-google-cloud-storage'));
    fireEvent.change(screen.getByTestId('remote-storage-bucket-input'), { target: { value: 'halo-files' } });
    fireEvent.change(screen.getByTestId('remote-storage-oauth-client-id'), {
      target: { value: 'demo.apps.googleusercontent.com' },
    });
    fireEvent.click(screen.getByTestId('remote-storage-oauth-btn'));
    expect(vscode.posted.at(-1)).toEqual({
      type: 'startRemoteStorageOAuth',
      payload: {
        kind: 'google-cloud-storage',
        method: 'oauth',
        bucket: 'halo-files',
        clientId: 'demo.apps.googleusercontent.com',
      },
    });

    // 展开高级手动凭据也可保存
    fireEvent.click(screen.getByTestId('remote-storage-manual-toggle'));
    fireEvent.change(screen.getByTestId('remote-storage-name-input'), { target: { value: 'My GCS' } });
    fireEvent.change(screen.getByTestId('remote-storage-secret-input'), { target: { value: 'ya29.token' } });
    fireEvent.click(screen.getByTestId('remote-storage-submit-btn'));

    expect(vscode.posted.at(-1)).toEqual({
      type: 'upsertRemoteStorage',
      payload: {
        name: 'My GCS',
        kind: 'google-cloud-storage',
        bucket: 'halo-files',
        secret: 'ya29.token',
      },
    });

    // 2. 本地上传按钮触发 uploadLocalFiles
    fireEvent.click(screen.getByTestId('right-panel-files-upload'));
    expect(vscode.posted.at(-1)).toEqual({
      type: 'uploadLocalFiles',
      payload: {},
    });

    // 3. 本地新建文件夹弹窗
    fireEvent.click(screen.getByTestId('right-panel-files-mkdir'));
    fireEvent.change(screen.getByTestId('right-panel-mkdir-input'), { target: { value: 'docs' } });
    fireEvent.click(screen.getByTestId('right-panel-mkdir-confirm'));
    expect(vscode.posted.at(-1)).toEqual({
      type: 'createLocalFolder',
      payload: { name: 'docs' },
    });

    // 4. 本地删除先弹二次确认再发送 deleteLocalFile
    fireEvent.click(screen.getByTestId('right-panel-delete-README.md'));
    expect(screen.getByTestId('right-panel-delete-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('right-panel-delete-confirm'));
    expect(vscode.posted.at(-1)).toEqual({
      type: 'deleteLocalFile',
      payload: { path: 'README.md', kind: 'file' },
    });
  });

  it('远端文件列表支持预览、下载、删除与面包屑展示', () => {
    render(<WorkbenchRightPanel />);
    act(() => {
      setRightPanelOpen(true);
      setRightPanelTab('files');
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          remoteStorages: {
            items: [
              {
                id: 'gcs-1',
                name: 'Google Cloud',
                kind: 'google-cloud-storage',
                bucket: 'my-bucket',
                hasSecret: true,
                createdAt: 1,
              },
            ],
          },
        }),
      });
    });

    // 切换到远端存储源，应立即发出 listRemoteFiles 请求
    fireEvent.click(screen.getByTestId('right-panel-files-source'));
    fireEvent.click(screen.getByText('Google Cloud'));

    const listMsg = [...vscode.posted].reverse().find((m) => m.type === 'listRemoteFiles');
    expect(listMsg).toBeTruthy();
    const listReqId = listMsg && listMsg.type === 'listRemoteFiles' ? listMsg.payload.requestId : 1;

    act(() => {
      applyHostMessage({
        type: 'remoteFilesListed',
        payload: {
          requestId: listReqId,
          storageId: 'gcs-1',
          dirPath: 'docs',
          breadcrumbs: [
            { id: '', label: 'Google Cloud' },
            { id: 'docs', label: 'docs' },
          ],
          items: [
            { id: 'docs/sub/', name: 'sub', path: 'docs/sub', kind: 'directory' },
            { id: 'docs/guide.md', name: 'guide.md', path: 'docs/guide.md', kind: 'file', size: 2048 },
          ],
        },
      });
    });
    vscode.posted.length = 0;

    expect(screen.getByTestId('right-panel-remote-breadcrumbs')).toBeTruthy();
    expect(screen.getByTestId('right-panel-remote-item-guide.md')).toBeTruthy();

    // 点击远端文件触发预览
    fireEvent.click(screen.getByTestId('right-panel-remote-item-guide.md'));
    expect(vscode.posted.at(-1)).toEqual({
      type: 'previewRemoteFile',
      payload: { storageId: 'gcs-1', entryId: 'docs/guide.md', path: 'docs/guide.md', name: 'guide.md' },
    });

    // 点击下载
    fireEvent.click(screen.getByTestId('right-panel-remote-download-guide.md'));
    expect(vscode.posted.at(-1)).toEqual({
      type: 'downloadRemoteFile',
      payload: { storageId: 'gcs-1', entryId: 'docs/guide.md', path: 'docs/guide.md', name: 'guide.md' },
    });

    // 点击删除触发二次确认
    fireEvent.click(screen.getByTestId('right-panel-remote-delete-guide.md'));
    fireEvent.click(screen.getByTestId('right-panel-delete-confirm'));
    expect(vscode.posted.at(-1)).toEqual({
      type: 'deleteRemoteFile',
      payload: {
        storageId: 'gcs-1',
        entryId: 'docs/guide.md',
        path: 'docs/guide.md',
        name: 'guide.md',
        kind: 'file',
      },
    });
  });
});
