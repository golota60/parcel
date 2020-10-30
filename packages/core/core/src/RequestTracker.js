// @flow strict-local

import type {AbortSignal} from 'abortcontroller-polyfill/dist/cjs-ponyfill';
import type {Async, ExtensionlessFileInvalidation, File, FilePath, FileCreateInvalidation, Glob, EnvMap} from '@parcel/types';
import type {Event} from '@parcel/watcher';
import type WorkerFarm from '@parcel/workers';
import type {NodeId, ParcelOptions, RequestInvalidation} from './types';

import invariant from 'assert';
import nullthrows from 'nullthrows';
import {isGlobMatch, isDirectoryInside} from '@parcel/utils';
import path from 'path';
import Graph, {type GraphOpts} from './Graph';
import {assertSignalNotAborted, hashFromOption} from './utils';

type SerializedRequestGraph = {|
  ...GraphOpts<RequestGraphNode, RequestGraphEdgeType>,
  invalidNodeIds: Set<NodeId>,
  incompleteNodeIds: Set<NodeId>,
  globNodeIds: Set<NodeId>,
  envNodeIds: Set<NodeId>,
  optionNodeIds: Set<NodeId>,
  unpredicatableNodeIds: Set<NodeId>,
|};

type FileNode = {|id: string, +type: 'file', value: File|};
type GlobNode = {|id: string, +type: 'glob', value: Glob|};
type ExtensionlessFileNode = {|
  id: string,
  +type: 'extensionless_file',
  value: ExtensionlessFileInvalidation
|};
type FileNameNode = {|
  id: string,
  +type: 'file_name',
  value: string
|};
type EnvNode = {|
  id: string,
  +type: 'env',
  value: {|key: string, value: string|},
|};

type OptionNode = {|
  id: string,
  +type: 'option',
  value: {|key: string, hash: string|},
|};

type Request<TInput, TResult> = {|
  id: string,
  +type: string,
  input: TInput,
  run: ({|input: TInput, ...StaticRunOpts|}) => Async<TResult>,
|};

type StoredRequest = {|
  id: string,
  +type: string,
  input: mixed,
  result?: mixed,
|};

type RequestNode = {|
  id: string,
  +type: 'request',
  value: StoredRequest,
|};
type RequestGraphNode =
  | RequestNode
  | FileNode
  | GlobNode
  | ExtensionlessFileNode
  | FileNameNode
  | EnvNode
  | OptionNode;

type RequestGraphEdgeType =
  | 'subrequest'
  | 'invalidated_by_update'
  | 'invalidated_by_delete'
  | 'invalidated_by_create'
  | 'invalidated_by_create_above'
  | 'dirname';

export type RunAPI = {|
  invalidateOnFileCreate: (FileCreateInvalidation) => void,
  invalidateOnFileDelete: FilePath => void,
  invalidateOnFileUpdate: FilePath => void,
  invalidateOnStartup: () => void,
  invalidateOnEnvChange: string => void,
  invalidateOnOptionChange: string => void,
  getInvalidations(): Array<RequestInvalidation>,
  storeResult: (result: mixed) => void,
  runRequest: <TInput, TResult>(
    subRequest: Request<TInput, TResult>,
  ) => Async<TResult>,
|};

export type StaticRunOpts = {|
  farm: WorkerFarm,
  options: ParcelOptions,
  api: RunAPI,
|};

const nodeFromFilePath = (filePath: string) => ({
  id: filePath,
  type: 'file',
  value: {filePath},
});

const nodeFromGlob = (glob: Glob) => ({
  id: glob,
  type: 'glob',
  value: glob,
});

const extensionlessFileNodeId = (filePath: FilePath) => 'extensionless_file:' + filePath;
const nodeFromExtensionlessFilePath = (filePath: FilePath, extensions: Set<string>) => ({
  id: extensionlessFileNodeId(filePath),
  type: 'extensionless_file',
  value: {filePath, extensions},
});

const nodeFromFileName = (fileName: string) => ({
  id: 'file_name:' + fileName,
  type: 'file_name',
  value: fileName,
});

const nodeFromRequest = (request: StoredRequest) => ({
  id: request.id,
  type: 'request',
  value: request,
});

const nodeFromEnv = (env: string, value: string) => ({
  id: 'env:' + env,
  type: 'env',
  value: {
    key: env,
    value,
  },
});

const nodeFromOption = (option: string, value: mixed) => ({
  id: 'option:' + option,
  type: 'option',
  value: {
    key: option,
    hash: hashFromOption(value),
  },
});

export class RequestGraph extends Graph<
  RequestGraphNode,
  RequestGraphEdgeType,
> {
  invalidNodeIds: Set<NodeId> = new Set();
  incompleteNodeIds: Set<NodeId> = new Set();
  globNodeIds: Set<NodeId> = new Set();
  envNodeIds: Set<NodeId> = new Set();
  optionNodeIds: Set<NodeId> = new Set();
  // Unpredictable nodes are requests that cannot be predicted whether they should rerun based on
  // filesystem changes alone. They should rerun on each startup of Parcel.
  unpredicatableNodeIds: Set<NodeId> = new Set();

  // $FlowFixMe
  static deserialize(opts: SerializedRequestGraph): RequestGraph {
    // $FlowFixMe Added in Flow 0.121.0 upgrade in #4381
    let deserialized = new RequestGraph(opts);
    deserialized.invalidNodeIds = opts.invalidNodeIds;
    deserialized.incompleteNodeIds = opts.incompleteNodeIds;
    deserialized.globNodeIds = opts.globNodeIds;
    deserialized.envNodeIds = opts.envNodeIds;
    deserialized.optionNodeIds = opts.optionNodeIds;
    deserialized.unpredicatableNodeIds = opts.unpredicatableNodeIds;
    // $FlowFixMe Added in Flow 0.121.0 upgrade in #4381 (Windows only)
    return deserialized;
  }

  // $FlowFixMe
  serialize(): SerializedRequestGraph {
    return {
      ...super.serialize(),
      invalidNodeIds: this.invalidNodeIds,
      incompleteNodeIds: this.incompleteNodeIds,
      globNodeIds: this.globNodeIds,
      envNodeIds: this.envNodeIds,
      optionNodeIds: this.optionNodeIds,
      unpredicatableNodeIds: this.unpredicatableNodeIds,
    };
  }

  addNode(node: RequestGraphNode): RequestGraphNode {
    if (!this.hasNode(node.id)) {
      if (node.type === 'glob') {
        this.globNodeIds.add(node.id);
      }

      if (node.type === 'env') {
        this.envNodeIds.add(node.id);
      }

      if (node.type === 'option') {
        this.optionNodeIds.add(node.id);
      }
    }

    return super.addNode(node);
  }

  removeNode(node: RequestGraphNode): void {
    this.invalidNodeIds.delete(node.id);
    this.incompleteNodeIds.delete(node.id);
    if (node.type === 'glob') {
      this.globNodeIds.delete(node.id);
    }
    if (node.type === 'env') {
      this.envNodeIds.delete(node.id);
    }
    if (node.type === 'option') {
      this.optionNodeIds.delete(node.id);
    }
    return super.removeNode(node);
  }

  getRequestNode(
    id: string,
  ): {|id: string, +type: 'request', value: StoredRequest|} {
    let node = nullthrows(this.getNode(id));
    invariant(node.type === 'request');
    return node;
  }

  completeRequest(request: StoredRequest) {
    this.invalidNodeIds.delete(request.id);
    this.incompleteNodeIds.delete(request.id);
  }

  replaceSubrequests(
    requestId: string,
    subrequestNodes: Array<RequestGraphNode>,
  ) {
    let requestNode = this.getRequestNode(requestId);
    if (!this.hasNode(requestId)) {
      this.addNode(requestNode);
    }

    this.replaceNodesConnectedTo(
      requestNode,
      subrequestNodes,
      null,
      'subrequest',
    );
  }

  invalidateNode(node: RequestGraphNode) {
    invariant(node.type === 'request');
    if (this.hasNode(node.id)) {
      this.invalidNodeIds.add(node.id);

      let parentNodes = this.getNodesConnectedTo(node, 'subrequest');
      for (let parentNode of parentNodes) {
        this.invalidateNode(parentNode);
      }
    }
  }

  invalidateUnpredictableNodes() {
    for (let nodeId of this.unpredicatableNodeIds) {
      let node = nullthrows(this.getNode(nodeId));
      invariant(node.type !== 'file' && node.type !== 'glob');
      this.invalidateNode(node);
    }
  }

  invalidateEnvNodes(env: EnvMap) {
    for (let nodeId of this.envNodeIds) {
      let node = nullthrows(this.getNode(nodeId));
      invariant(node.type === 'env');
      if (env[node.value.key] !== node.value.value) {
        let parentNodes = this.getNodesConnectedTo(
          node,
          'invalidated_by_update',
        );
        for (let parentNode of parentNodes) {
          this.invalidateNode(parentNode);
        }
      }
    }
  }

  invalidateOptionNodes(options: ParcelOptions) {
    for (let nodeId of this.optionNodeIds) {
      let node = nullthrows(this.getNode(nodeId));
      invariant(node.type === 'option');
      if (hashFromOption(options[node.value.key]) !== node.value.hash) {
        let parentNodes = this.getNodesConnectedTo(
          node,
          'invalidated_by_update',
        );
        for (let parentNode of parentNodes) {
          this.invalidateNode(parentNode);
        }
      }
    }
  }

  invalidateOnFileUpdate(requestId: string, filePath: FilePath) {
    let requestNode = this.getRequestNode(requestId);
    let fileNode = nodeFromFilePath(filePath);
    if (!this.hasNode(fileNode.id)) {
      this.addNode(fileNode);
    }

    if (!this.hasEdge(requestNode.id, fileNode.id, 'invalidated_by_update')) {
      this.addEdge(requestNode.id, fileNode.id, 'invalidated_by_update');
    }
  }

  invalidateOnFileDelete(requestId: string, filePath: FilePath) {
    let requestNode = this.getRequestNode(requestId);
    let fileNode = nodeFromFilePath(filePath);
    if (!this.hasNode(fileNode.id)) {
      this.addNode(fileNode);
    }

    if (!this.hasEdge(requestNode.id, fileNode.id, 'invalidated_by_delete')) {
      this.addEdge(requestNode.id, fileNode.id, 'invalidated_by_delete');
    }
  }

  invalidateOnFileCreate(requestId: string, input: FileCreateInvalidation) {
    let requestNode = this.getRequestNode(requestId);
    let node;
    if (input.glob != null) {
      node = nodeFromGlob(input.glob);
    } else if (input.extensions) {
      node = nodeFromExtensionlessFilePath(input.filePath, input.extensions);
      if (this.hasNode(node.id)) {
        node = this.getNode(node.id);
        console.log(input, node)
        invariant(node?.type === 'extensionless_file');
        node.value.extensions = new Set([...node.value.extensions, ...input.extensions]);
      }
    } else if (input.fileName != null && input.aboveFilePath != null) {
      let aboveFilePath = input.aboveFilePath;
      let parts = input.fileName.split('/').reverse();
      let last;
      for (let part of parts) {
        let fileNameNode = nodeFromFileName(part);
        if (!this.hasNode(fileNameNode.id)) {
          this.addNode(fileNameNode);
        }

        console.log(fileNameNode)

        if (last != null && !this.hasEdge(last.id, fileNameNode.id, 'dirname')) {
          this.addEdge(last.id, fileNameNode.id, 'dirname');
        }

        last = fileNameNode;
      }
      
      node = nodeFromFilePath(aboveFilePath);
      console.log(node)
      if (!this.hasNode(node.id)) {
        this.addNode(node);
      }

      if (last != null && !this.hasEdge(last.id, node.id, 'invalidated_by_create_above')) {
        this.addEdge(node.id, last.id, 'invalidated_by_create_above');
      }
    } else {
      throw new Error('Invalid invalidation');
    }

    if (!this.hasNode(node.id)) {
      this.addNode(node);
    }

    if (!this.hasEdge(requestNode.id, node.id, 'invalidated_by_create')) {
      this.addEdge(requestNode.id, node.id, 'invalidated_by_create');
    }
  }

  invalidateOnStartup(requestId: string) {
    let requestNode = this.getRequestNode(requestId);
    this.unpredicatableNodeIds.add(requestNode.id);
  }

  invalidateOnEnvChange(requestId: string, env: string, value: string) {
    let requestNode = this.getRequestNode(requestId);
    let envNode = nodeFromEnv(env, value);
    if (!this.hasNode(envNode.id)) {
      this.addNode(envNode);
    }

    if (!this.hasEdge(requestNode.id, envNode.id, 'invalidated_by_update')) {
      this.addEdge(requestNode.id, envNode.id, 'invalidated_by_update');
    }
  }

  invalidateOnOptionChange(requestId: string, option: string, value: mixed) {
    let requestNode = this.getRequestNode(requestId);
    let optionNode = nodeFromOption(option, value);
    if (!this.hasNode(optionNode.id)) {
      this.addNode(optionNode);
    }

    if (!this.hasEdge(requestNode.id, optionNode.id, 'invalidated_by_update')) {
      this.addEdge(requestNode.id, optionNode.id, 'invalidated_by_update');
    }
  }

  clearInvalidations(node: RequestNode) {
    this.unpredicatableNodeIds.delete(node.id);
    this.replaceNodesConnectedTo(node, [], null, 'invalidated_by_update');
    this.replaceNodesConnectedTo(node, [], null, 'invalidated_by_delete');
    this.replaceNodesConnectedTo(node, [], null, 'invalidated_by_create');
  }

  getInvalidations(requestId: string): Array<RequestInvalidation> {
    if (!this.hasNode(requestId)) {
      return [];
    }

    // For now just handling updates. Could add creates/deletes later if needed.
    let requestNode = this.getRequestNode(requestId);
    let invalidations = this.getNodesConnectedFrom(
      requestNode,
      'invalidated_by_update',
    );
    return invalidations
      .map(node => {
        switch (node.type) {
          case 'file':
            return {type: 'file', filePath: node.value.filePath};
          case 'env':
            return {type: 'env', key: node.value.key};
        }
      })
      .filter(Boolean);
  }

  invalidateFileNameNode(node: FileNameNode, filePath: FilePath) {
    let dirname = path.dirname(filePath);
    let above = this.getNodesConnectedTo(node, 'invalidated_by_create_above');
    for (let aboveNode of above) {
      invariant(aboveNode.type === 'file');
      if (isDirectoryInside(aboveNode.value.filePath, dirname)) {
        let connectedNodes = this.getNodesConnectedTo(
          aboveNode,
          'invalidated_by_create',
        );
        for (let connectedNode of connectedNodes) {
          this.invalidateNode(connectedNode);
        }
      }
    }

    let basename = path.basename(dirname);
    let parent = this.getNode('file_name: ' + basename);
    if (parent != null && this.hasEdge(parent.id, node.id, 'dirname')) {
      invariant(parent.type === 'file_name');
      this.invalidateFileNameNode(parent, dirname);
    }
  }

  respondToFSEvents(events: Array<Event>): boolean {
    for (let {path: filePath, type} of events) {
      let node = this.getNode(filePath);

      // sometimes mac os reports update events as create events
      // if it was a create event, but the file already exists in the graph,
      // then we can assume it was actually an update event
      if (node && (type === 'create' || type === 'update')) {
        for (let connectedNode of this.getNodesConnectedTo(
          node,
          'invalidated_by_update',
        )) {
          this.invalidateNode(connectedNode);
        }
      } else if (type === 'create') {
        let extension = path.extname(filePath);
        let extensionlessFilePath = filePath.slice(0, -extension.length);
        let extensionlessFileNode = this.getNode(extensionlessFileNodeId(extensionlessFilePath));

        if (
          extensionlessFileNode?.type === 'extensionless_file' && 
          extensionlessFileNode.value.extensions.has(extension)
        ) {
          let connectedNodes = this.getNodesConnectedTo(
            extensionlessFileNode,
            'invalidated_by_create',
          );
          for (let connectedNode of connectedNodes) {
            this.invalidateNode(connectedNode);
          }
        }
        
        let basename = path.basename(filePath);
        let fileNameNode = this.getNode('file_name:' + basename);
        if (fileNameNode?.type === 'file_name') {
          this.invalidateFileNameNode(fileNameNode, filePath);
        }

        for (let id of this.globNodeIds) {
          let globNode = this.getNode(id);
          invariant(globNode && globNode.type === 'glob');

          if (isGlobMatch(filePath, globNode.value)) {
            let connectedNodes = this.getNodesConnectedTo(
              globNode,
              'invalidated_by_create',
            );
            for (let connectedNode of connectedNodes) {
              this.invalidateNode(connectedNode);
            }
          }
        }
      } else if (node && type === 'delete') {
        for (let connectedNode of this.getNodesConnectedTo(
          node,
          'invalidated_by_delete',
        )) {
          this.invalidateNode(connectedNode);
        }
      }
    }

    return this.invalidNodeIds.size > 0;
  }
}

export default class RequestTracker {
  graph: RequestGraph;
  farm: WorkerFarm;
  options: ParcelOptions;
  signal: ?AbortSignal;

  constructor({
    graph,
    farm,
    options,
  }: {|
    graph?: RequestGraph,
    farm: WorkerFarm,
    options: ParcelOptions,
  |}) {
    this.graph = graph || new RequestGraph();
    this.farm = farm;
    this.options = options;
  }

  // TODO: refactor (abortcontroller should be created by RequestTracker)
  setSignal(signal?: AbortSignal) {
    this.signal = signal;
  }

  startRequest(request: StoredRequest) {
    if (!this.graph.hasNode(request.id)) {
      let node = nodeFromRequest(request);
      this.graph.addNode(node);
    } else {
      // Clear existing invalidations for the request so that the new
      // invalidations created during the request replace the existing ones.
      this.graph.clearInvalidations(this.graph.getRequestNode(request.id));
    }

    this.graph.incompleteNodeIds.add(request.id);
    this.graph.invalidNodeIds.delete(request.id);
  }

  removeRequest(id: string) {
    this.graph.removeById(id);
  }

  storeResult(id: string, result: mixed) {
    let node = this.graph.getNode(id);
    if (node && node.type === 'request') {
      node.value.result = result;
    }
  }

  hasValidResult(id: string): boolean {
    return (
      this.graph.nodes.has(id) &&
      !this.graph.invalidNodeIds.has(id) &&
      !this.graph.incompleteNodeIds.has(id)
    );
  }

  getRequestResult<T>(id: string): T {
    let node = nullthrows(this.graph.getNode(id));
    invariant(node.type === 'request');
    // $FlowFixMe
    let result: T = (node.value.result: any);
    return result;
  }

  completeRequest(id: string) {
    this.graph.invalidNodeIds.delete(id);
    this.graph.incompleteNodeIds.delete(id);
  }

  rejectRequest(id: string) {
    this.graph.incompleteNodeIds.delete(id);
    if (this.graph.hasNode(id)) {
      this.graph.invalidNodeIds.add(id);
    }
  }

  respondToFSEvents(events: Array<Event>): boolean {
    return this.graph.respondToFSEvents(events);
  }

  hasInvalidRequests(): boolean {
    return this.graph.invalidNodeIds.size > 0;
  }

  getInvalidRequests(): Array<StoredRequest> {
    let invalidRequests = [];
    for (let id of this.graph.invalidNodeIds) {
      let node = nullthrows(this.graph.getNode(id));
      invariant(node.type === 'request');
      invalidRequests.push(node.value);
    }
    return invalidRequests;
  }

  replaceSubrequests(
    requestId: string,
    subrequestNodes: Array<RequestGraphNode>,
  ) {
    this.graph.replaceSubrequests(requestId, subrequestNodes);
  }

  async runRequest<TInput, TResult>(
    request: Request<TInput, TResult>,
  ): Async<TResult> {
    let id = request.id;

    if (this.hasValidResult(id)) {
      return this.getRequestResult<TResult>(id);
    }

    let {api, subRequests} = this.createAPI(id);
    try {
      this.startRequest({id, type: request.type, input: request.input});
      let result = await request.run({
        input: request.input,
        api,
        farm: this.farm,
        options: this.options,
      });

      assertSignalNotAborted(this.signal);
      this.completeRequest(id);

      return result;
    } catch (err) {
      this.rejectRequest(id);
      throw err;
    } finally {
      this.graph.replaceSubrequests(
        id,
        [...subRequests].map(subRequestId =>
          nullthrows(this.graph.getNode(subRequestId)),
        ),
      );
    }
  }

  createAPI(requestId: string): {|api: RunAPI, subRequests: Set<NodeId>|} {
    let subRequests = new Set();
    let api = {
      invalidateOnFileCreate: (input) =>
        this.graph.invalidateOnFileCreate(requestId, input),
      invalidateOnFileDelete: filePath =>
        this.graph.invalidateOnFileDelete(requestId, filePath),
      invalidateOnFileUpdate: filePath =>
        this.graph.invalidateOnFileUpdate(requestId, filePath),
      invalidateOnStartup: () => this.graph.invalidateOnStartup(requestId),
      invalidateOnEnvChange: env =>
        this.graph.invalidateOnEnvChange(
          requestId,
          env,
          this.options.env[env] || '',
        ),
      invalidateOnOptionChange: option =>
        this.graph.invalidateOnOptionChange(
          requestId,
          option,
          this.options[option],
        ),
      getInvalidations: () => this.graph.getInvalidations(requestId),
      storeResult: result => {
        this.storeResult(requestId, result);
      },
      runRequest: <TInput, TResult>(
        subRequest: Request<TInput, TResult>,
      ): Async<TResult> => {
        subRequests.add(subRequest.id);
        return this.runRequest<TInput, TResult>(subRequest);
      },
    };

    return {api, subRequests};
  }
}
