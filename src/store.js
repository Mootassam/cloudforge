'use strict';
// Local JSON data store for CloudForge Admin.
// Kept electron-free so it can be unit-tested.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createStore(filePath) {
  function normalize(d) {
    d = d && typeof d === 'object' ? d : {};
    const projects = (Array.isArray(d.projects) ? d.projects : []).map(p => {
      if (!p || typeof p !== 'object') return p;
      if (!Array.isArray(p.domains)) p.domains = p.domain ? [p.domain] : [];
      if (!p.domain && p.domains[0]) p.domain = p.domains[0];
      return p;
    });
    return {
      projects,
      globalRules: typeof d.globalRules === 'string' ? d.globalRules : '',
      settings: d.settings && typeof d.settings === 'object' ? d.settings : {},
      history: d.history && typeof d.history === 'object' ? d.history : {}
    };
  }

  function read() {
    try { return normalize(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
    catch { return normalize({}); }
  }

  function write(data) {
    try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch {}
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return data;
  }

  function upsertProject(project) {
    const data = read();
    const now = new Date().toISOString();
    if (project.id) {
      const i = data.projects.findIndex(p => p.id === project.id);
      if (i >= 0) {
        data.projects[i] = { ...data.projects[i], ...project, updatedAt: now };
        if (project.domains) data.projects[i].domain = project.domains[0] || '';
        write(data);
        return data.projects[i];
      }
    }
    const created = {
      id: crypto.randomUUID(),
      createdAt: now, updatedAt: now,
      apiKeySet: false, accessCode: '', rules: '',
      vps: {}, containers: {}, domains: [],
      ...project
    };
    if (!created.domains.length && created.domain) created.domains = [created.domain];
    data.projects.push(created);
    write(data);
    return created;
  }

  function deleteProject(id) {
    const data = read();
    data.projects = data.projects.filter(p => p.id !== id);
    if (data.history) delete data.history[id];
    write(data);
    return true;
  }

  function getProject(id) { return read().projects.find(p => p.id === id) || null; }

  function setGlobalRules(text) { const d = read(); d.globalRules = String(text || ''); write(d); return d.globalRules; }

  function setApiKeyStatus(id, apiKeySet) {
    const d = read(); const p = d.projects.find(x => x.id === id);
    if (p) { p.apiKeySet = !!apiKeySet; p.updatedAt = new Date().toISOString(); write(d); }
    return p || null;
  }

  function setAccessCode(id, code) {
    const d = read(); const p = d.projects.find(x => x.id === id);
    if (p) { p.accessCode = code; p.updatedAt = new Date().toISOString(); write(d); }
    return p || null;
  }

  function setSettings(patch) {
    const d = read(); d.settings = { ...d.settings, ...(patch || {}) }; write(d); return d.settings;
  }

  function addDeploy(projectId, entry) {
    const d = read();
    d.history = d.history || {};
    d.history[projectId] = d.history[projectId] || [];
    d.history[projectId].unshift({ at: new Date().toISOString(), ...entry });
    d.history[projectId] = d.history[projectId].slice(0, 50);
    write(d);
    return d.history[projectId];
  }

  function getHistory(projectId) { const d = read(); return (d.history && d.history[projectId]) || []; }

  return {
    read, write, upsertProject, deleteProject, getProject,
    setGlobalRules, setApiKeyStatus, setAccessCode,
    setSettings, addDeploy, getHistory
  };
}

module.exports = { createStore };
