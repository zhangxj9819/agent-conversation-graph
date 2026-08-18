/**
 * 插件内的虚拟子项目存储。
 *
 * 数据只写入 VS Code workspaceState；conversationKey 只是对现有 Claude/Codex
 * 对话的稳定引用，不移动、不改写任何 JSONL 文件。再按工作区根路径分桶，避免同一个
 * VS Code 窗口切换目录后分类互相串扰。
 */
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const STATE_KEY = "conversationGraph.subprojects.v1";
const MAX_NAME_LENGTH = 80;

function workspaceKey(workspacePath) {
  return typeof workspacePath === "string" && workspacePath
    ? path.resolve(workspacePath) : "";
}

function cleanName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function emptyState() {
  return { version: 1, workspaces: {} };
}

function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== "object" || !raw.workspaces ||
      typeof raw.workspaces !== "object") return state;

  for (const [root, value] of Object.entries(raw.workspaces)) {
    if (!root || !value || typeof value !== "object") continue;
    const projects = [];
    const ids = new Set();
    const names = new Set();
    for (const item of Array.isArray(value.projects) ? value.projects : []) {
      const id = typeof item?.id === "string" ? item.id : "";
      const name = cleanName(item?.name);
      const folded = name.toLocaleLowerCase();
      if (!id || !name || name.length > MAX_NAME_LENGTH || ids.has(id) || names.has(folded)) continue;
      ids.add(id);
      names.add(folded);
      projects.push({
        id,
        name,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
      });
    }
    const assignments = {};
    if (value.assignments && typeof value.assignments === "object") {
      for (const [conversationKey, projectId] of Object.entries(value.assignments)) {
        if (conversationKey && typeof projectId === "string" && ids.has(projectId)) {
          assignments[conversationKey] = projectId;
        }
      }
    }
    state.workspaces[path.resolve(root)] = { projects, assignments };
  }
  return state;
}

class SubprojectStore {
  constructor(memento, idFactory = () => crypto.randomUUID()) {
    let volatile = emptyState();
    this.memento = memento || {
      get: (_key, fallback) => volatile || fallback,
      update: async (_key, value) => { volatile = value; },
    };
    this.idFactory = idFactory;
  }

  _read() {
    return normalizeState(this.memento.get(STATE_KEY, emptyState()));
  }

  _bucket(state, workspacePath, create = false) {
    const root = workspaceKey(workspacePath);
    if (!root) return null;
    if (!state.workspaces[root] && create) {
      state.workspaces[root] = { projects: [], assignments: {} };
    }
    return state.workspaces[root] || null;
  }

  list(workspacePath) {
    const bucket = this._bucket(this._read(), workspacePath);
    return (bucket?.projects || []).map(project => ({ ...project }));
  }

  get(workspacePath, projectId) {
    return this.list(workspacePath).find(project => project.id === projectId) || null;
  }

  assignmentFor(workspacePath, conversationKey) {
    if (typeof conversationKey !== "string" || !conversationKey) return null;
    const bucket = this._bucket(this._read(), workspacePath);
    return bucket?.assignments?.[conversationKey] || null;
  }

  assignments(workspacePath) {
    const bucket = this._bucket(this._read(), workspacePath);
    return { ...(bucket?.assignments || {}) };
  }

  validateName(workspacePath, value, excludeId = null) {
    const name = cleanName(value);
    if (!name) return "子项目名称不能为空";
    if (name.length > MAX_NAME_LENGTH) return `子项目名称不能超过 ${MAX_NAME_LENGTH} 个字符`;
    const duplicate = this.list(workspacePath).some(project =>
      project.id !== excludeId && project.name.localeCompare(name, undefined, {
        sensitivity: "accent",
      }) === 0);
    return duplicate ? "已经存在同名子项目" : undefined;
  }

  async create(workspacePath, value) {
    const error = this.validateName(workspacePath, value);
    if (error) throw new Error(error);
    const state = this._read();
    const bucket = this._bucket(state, workspacePath, true);
    const now = new Date().toISOString();
    const project = {
      id: this.idFactory(),
      name: cleanName(value),
      createdAt: now,
      updatedAt: now,
    };
    bucket.projects.push(project);
    await this.memento.update(STATE_KEY, state);
    return { ...project };
  }

  async rename(workspacePath, projectId, value) {
    const error = this.validateName(workspacePath, value, projectId);
    if (error) throw new Error(error);
    const state = this._read();
    const bucket = this._bucket(state, workspacePath);
    const project = bucket?.projects.find(item => item.id === projectId);
    if (!project) throw new Error("子项目不存在或已经被删除");
    project.name = cleanName(value);
    project.updatedAt = new Date().toISOString();
    await this.memento.update(STATE_KEY, state);
    return { ...project };
  }

  async delete(workspacePath, projectId) {
    const state = this._read();
    const bucket = this._bucket(state, workspacePath);
    const index = bucket?.projects.findIndex(project => project.id === projectId) ?? -1;
    if (!bucket || index < 0) throw new Error("子项目不存在或已经被删除");
    const [project] = bucket.projects.splice(index, 1);
    let unassigned = 0;
    for (const [conversationKey, assignedId] of Object.entries(bucket.assignments)) {
      if (assignedId !== projectId) continue;
      delete bucket.assignments[conversationKey];
      unassigned++;
    }
    await this.memento.update(STATE_KEY, state);
    return { project: { ...project }, unassigned };
  }

  async assign(workspacePath, conversationKey, projectId) {
    if (typeof conversationKey !== "string" || !conversationKey) {
      throw new Error("对话标识无效");
    }
    const state = this._read();
    const bucket = this._bucket(state, workspacePath);
    if (!bucket?.projects.some(project => project.id === projectId)) {
      throw new Error("子项目不存在或已经被删除");
    }
    bucket.assignments[conversationKey] = projectId;
    await this.memento.update(STATE_KEY, state);
  }

  async unassign(workspacePath, conversationKey) {
    if (typeof conversationKey !== "string" || !conversationKey) return false;
    const state = this._read();
    const bucket = this._bucket(state, workspacePath);
    if (!bucket || !(conversationKey in bucket.assignments)) return false;
    delete bucket.assignments[conversationKey];
    await this.memento.update(STATE_KEY, state);
    return true;
  }
}

module.exports = {
  STATE_KEY,
  MAX_NAME_LENGTH,
  SubprojectStore,
  cleanName,
  normalizeState,
};
