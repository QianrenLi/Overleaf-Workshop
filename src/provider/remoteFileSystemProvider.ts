import * as vscode from 'vscode';
import { SocketIOAPI } from '../api/socketio';
import { GlobalStateManager } from '../utils/globalStateManager';
import { BaseAPI } from '../api/base';
import { assert } from 'console';

export type FileType = 'doc' | 'file' | 'folder';

export interface DocumentEntity {
    _id: string,
    name: string,
}

export interface FileRefEntity extends DocumentEntity {
    // _id: string,
    // name: string,
    linkedFileData: any,
    created: string,
}

export interface FolderEntity extends DocumentEntity {
    // _id: string,
    // name: string,
    docs: Array<DocumentEntity>,
    fileRefs: Array<FileRefEntity>,
    folders: Array<FolderEntity>,
}

export interface MemberEntity {
    _id: string,
    first_name: string,
    last_name?: string,
    email: string,
    privileges: string,
    signUpDate: string,
}

export interface ProjectEntity {
    _id: string,
    name: string,
    rootDoc_id: string,
    rootFolder: Array<FolderEntity>,
    publicAccessLevel: string, //"tokenBased"
    compiler: string, //"pdflatex"
    spellCheckLanguage: string, //"en"
    deletedDocs: Array<{
        _id: string,
        name: string,
        deletedAt: string,
    }>,
    members: Array<MemberEntity>,
    invites: Array<MemberEntity>,
    owner: MemberEntity,
    features: {[key:string]:any},
}

export class File implements vscode.FileStat {
    type: vscode.FileType;
    name: string;
    ctime: number;
    mtime: number;
    size: number;
    constructor(name: string, type: vscode.FileType, ctime?: number) {
        this.type = type;
        this.name = name;
        this.ctime = ctime || Date.now();
        this.mtime = Date.now();
        this.size = 0;
    }
}

class VirtualFileSystem {
    private root?: ProjectEntity;
    private context: vscode.ExtensionContext;
    private api: BaseAPI;
    private socket: SocketIOAPI;
    private origin: string;
    private userId: string;
    private projectId: string;
    private notify: (events:vscode.FileChangeEvent[])=>void;

    constructor(context: vscode.ExtensionContext, uri: vscode.Uri, notify: (events:vscode.FileChangeEvent[])=>void) {
        const {userId,projectId,path} = this.parseUri(uri);
        this.origin = uri.scheme + '://' + uri.authority;
        this.userId = userId;
        this.projectId = projectId;
        //
        this.context = context;
        this.notify = notify;
        //
        const res = GlobalStateManager.initSocketIOAPI(context, uri.authority);
        if (res) {
            this.api = res.api;
            this.socket = res.socket;
        } else {
            throw new Error(`Cannot init SocketIOAPI for ${uri.authority}`);
        }
    }

    async init() {
        this.remoteWatch();
        return this.socket.joinProject(this.projectId).then((project:ProjectEntity) => {
            this.root = project;
        });
    }

    private parseUri(uri: vscode.Uri) {
        const query:any = uri.query.split('&').reduce((acc, v) => {
            const [key,value] = v.split('=');
            return {...acc, [key]:value};
        }, {});
        const [userId, projectId] = [query.user, query.project];
        const path = uri.path;
        return {userId, projectId, path}
    }

    private _resolveUri(uri: vscode.Uri) {
        // resolve path
        const [parentFolder, fileName] = (() => {
            const path = uri.path;
            if (this.root) {
                let currentFolder = this.root.rootFolder[0];
                const pathParts = path.split('/').slice(1);
                for (let i = 0; i < pathParts.length-1; i++) {
                    const folderName = pathParts[i];
                    const folder = currentFolder.folders.find((folder) => folder.name === folderName);
                    if (folder) {
                        currentFolder = folder;
                    } else {
                        throw vscode.FileSystemError.FileNotFound(uri);
                    }
                }
                const fileName = pathParts[pathParts.length-1];
                return [currentFolder, fileName];
            }
            throw vscode.FileSystemError.FileNotFound(uri);
        })();
        // resolve file
        const [fileEntity, fileType, fileId] = (() => {
            // resolve as folder
            let folder = parentFolder.folders.find((folder) => folder.name === fileName);
            if (fileName==='') { folder = parentFolder; }
            if (folder) {
                return [folder, 'folder' as FileType, folder._id];
            }
            // resolve as doc
            const doc = parentFolder.docs.find((doc) => doc.name === fileName);
            if (doc) {
                return [doc, 'doc' as FileType, doc._id];
            }
            // resolve as file
            const file = parentFolder.fileRefs.find((file) => file.name === fileName);
            if (file) {
                return [file, 'file' as FileType, file._id];
            }
            return [];
        })();
        return {parentFolder, fileName, fileEntity, fileType, fileId};
    }

    private _resolveById(entityId: string, root?: FolderEntity, path?:string):{
        parentFolder: FolderEntity, fileEntity: DocumentEntity, fileType:FileType, path:string
    } | undefined {
        if (!this.root) {
            throw vscode.FileSystemError.FileNotFound();
        }
        root = root || this.root.rootFolder[0];
        path = path || '/';

        if (root._id === entityId) {
            return {parentFolder: root, fileType: 'folder', fileEntity: root, path};
        } else {
            // search in root
            const doc = root.docs.find((doc) => doc._id === entityId);
            if (doc) {
                return {parentFolder: root, fileType: 'doc', fileEntity: doc, path:path+doc.name};
            }
            const file = root.fileRefs.find((file) => file._id === entityId);
            if (file) {
                return {parentFolder: root, fileType: 'file', fileEntity: file, path:path+file.name};
            }
            // recursive search
            for (let i = 0; i < root.folders.length; i++) {
                const folder = root.folders[i];
                const res = this._resolveById(entityId, folder, path+folder.name+'/');
                if (res) return res;
            }
        }
        return undefined;
    }

    private insertEntity(parentFolder: FolderEntity, fileType:FileType, entity: DocumentEntity) {
        const key = fileType==='folder' ? 'folders' : fileType==='doc' ? 'docs' : 'fileRefs';
        parentFolder[key].push(entity as any);
    }

    private removeEntity(parentFolder: FolderEntity, fileType:FileType, entity: DocumentEntity) {
        const key = fileType==='folder' ? 'folders' : fileType==='doc' ? 'docs' : 'fileRefs';
        const index = parentFolder[key].findIndex((e) => e._id === entity._id);
        if (index>=0) {
            parentFolder[key].splice(index, 1);
        }
    }

    private removeEntityById(parentFolder: FolderEntity, fileType:FileType, entityId: string, recursive?:boolean) {
        const key = fileType==='folder' ? 'folders' : fileType==='doc' ? 'docs' : 'fileRefs';
        parentFolder[key] = parentFolder[key].filter((entity) => entity._id !== entityId) as any;
    }

    private remoteWatch() {
        this.socket.updateEventHandlers({
            onFileCreated: (parentFolderId:string, type:FileType, entity:DocumentEntity) => {
                const res = this._resolveById(parentFolderId);
                if (res) {
                    const {fileEntity} = res;
                    this.insertEntity(fileEntity as FolderEntity, type, entity);
                    this.notify([
                        {type: vscode.FileChangeType.Created, uri: vscode.Uri.parse(this.origin+res.path)}
                    ]);
                }
            },
            onFileRenamed: (entityId:string, newName:string) => {
                const res = this._resolveById(entityId);
                if (res) {
                    const {fileEntity} = res;
                    const oldName = fileEntity.name;
                    fileEntity.name = newName;
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: vscode.Uri.parse(this.origin+res.path)},
                        {type: vscode.FileChangeType.Created, uri: vscode.Uri.parse(this.origin+res.path.replace(oldName, newName))}
                    ]);
                }
            },
            onFileRemoved: (entityId:string) => {
                const res = this._resolveById(entityId);
                if (res) {
                    const {parentFolder, fileType, fileEntity} = res;
                    this.removeEntity(parentFolder, fileType, fileEntity);
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: vscode.Uri.parse(this.origin+res.path)}
                    ]);
                }
            },
            onFileMoved: (entityId:string, folderId:string) => {
                const oldPath = this._resolveById(entityId);
                const newPath = this._resolveById(folderId);
                if (oldPath && newPath) {
                    const newParentFolder = newPath.fileEntity as FolderEntity;
                    this.insertEntity(newParentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: vscode.Uri.parse(this.origin+oldPath.path)},
                        {type: vscode.FileChangeType.Created, uri: vscode.Uri.parse(this.origin+newPath.path+'/'+oldPath.fileEntity.name)}
                    ]);
                }
            },
        });
    }

    resolve(uri: vscode.Uri): File {
        const {fileName, fileType} = this._resolveUri(uri);
        if (fileType==='folder') {
            return new File(fileName, vscode.FileType.Directory);
        } else if (fileType==='doc') {
            return new File(fileName, vscode.FileType.File);
        } else if (fileType==='file') {
            return new File(fileName, vscode.FileType.File);
        }
        throw vscode.FileSystemError.FileNotFound(uri);
    }

    list(uri: vscode.Uri): [string, vscode.FileType][] {
        const {fileEntity} = this._resolveUri(uri);
        const folder = fileEntity as FolderEntity;
        let results:[string, vscode.FileType][] = [];
        if (folder) {
            folder.folders.forEach((folder) => {
                results.push([folder.name, vscode.FileType.Directory]);
            });
            folder.docs.forEach((doc) => {
                results.push([doc.name, vscode.FileType.File]);
            });
            folder.fileRefs.forEach((ref) => {
                results.push([ref.name, vscode.FileType.File]);
            });
        }
        return results;
    }

    async openFile(uri: vscode.Uri): Promise<Uint8Array> {
        const {fileType, fileId} = this._resolveUri(uri);
        // resolve as doc
        if (fileType=='doc' && fileId) {
            const res = await this.socket.joinDoc(fileId);
            const content = res.docLines.join('\n');
            return new TextEncoder().encode(content);
        } else if (fileType=='file' && fileId) {
            const serverName = uri.authority;
            const res = await GlobalStateManager.getProjectFile(this.context, this.api, serverName, this.projectId, fileId);
            return new Uint8Array(res);
        }
        throw vscode.FileSystemError.FileNotFound();
    }

    async mkdir(uri: vscode.Uri) {
        const {parentFolder, fileName} = this._resolveUri(uri);
        const serverName = uri.authority;
        const res = await GlobalStateManager.addProjectFolder(this.context, this.api, serverName, this.projectId, fileName, parentFolder._id);
        if (res) {
            this.insertEntity(parentFolder, 'folder', res);
        }
    }

    async remove(uri: vscode.Uri, recursive: boolean) {
        const {parentFolder, fileType, fileId} = this._resolveUri(uri);
        const serverName = uri.authority;
        
        if (fileType && fileId) {
            const res = await GlobalStateManager.deleteProjectEntity(this.context, this.api, serverName, this.projectId, fileType, fileId);
            if (res) {
                this.removeEntityById(parentFolder, fileType, fileId, recursive);
            }
        }
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, force: boolean) {
        const oldPath = this._resolveUri(oldUri);
        const newPath = this._resolveUri(newUri);
        const serverName = oldUri.authority;

        if (oldPath.fileType && oldPath.fileId && oldPath.fileEntity) {
            // delete existence firstly
            if (newPath.fileType && newPath.fileEntity) {
                if (!force) return;
                await this.remove(newUri, true);
                this.removeEntity(newPath.parentFolder, newPath.fileType, newPath.fileEntity);
            }
            // rename or move
            const res = (oldPath.parentFolder===newPath.parentFolder) ? (
                        // rename   
                        await GlobalStateManager.renameProjectEntity(this.context, this.api, serverName, this.projectId, oldPath.fileType, oldPath.fileId, newPath.fileName) ) : (
                        // move
                        await GlobalStateManager.moveProjectEntity(this.context, this.api, serverName, this.projectId, oldPath.fileType, oldPath.fileId, newPath.parentFolder._id) );
            if (res) {
                const newEntity = Object.assign(oldPath.fileEntity);
                newEntity.name = newPath.fileName;
                this.insertEntity(newPath.parentFolder, oldPath.fileType, newEntity);
                this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
            }
        }
    }
}

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    private vfss: {[key:string]:VirtualFileSystem};

    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
        this.vfss = {};
    }

    private getVFS(uri: vscode.Uri): Promise<VirtualFileSystem> {
        const vfs = this.vfss[ uri.query ];
        if (vfs) {
            return Promise.resolve(vfs);
        } else {
            const vfs = new VirtualFileSystem(this.context, uri, this.notify.bind(this));
            this.vfss[ uri.query ] = vfs;
            return vfs.init().then(() => vfs);
        }
    }

    notify(events :vscode.FileChangeEvent[]) {
        this._emitter.fire(events);
    }

    stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
        return this.getVFS(uri).then( vfs => vfs.resolve(uri) );
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
        return this.getVFS(uri).then( vfs => vfs.list(uri) );
    }

    createDirectory(uri: vscode.Uri): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.mkdir(uri) );
    }

    readFile(uri: vscode.Uri): Thenable<Uint8Array> {
        return this.getVFS(uri).then( vfs => vfs.openFile(uri) );
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Thenable<void> {
        return Promise.resolve(); //TODO:
    }

    delete(uri: vscode.Uri, options: { recursive: boolean; }): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.remove(uri, options.recursive) );
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Thenable<void> {
        assert( oldUri.authority===newUri.authority, 'Cannot rename across servers' );
        return this.getVFS(oldUri).then( vfs => vfs.rename(oldUri, newUri, options.overwrite) );
    }

}
