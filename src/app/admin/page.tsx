"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface User {
  id: string;
  username: string;
  role: string;
  created_at: string;
}

interface CurrentUser {
  username: string;
  role: string;
}

interface ColumnConfig {
  field: string;
  label: string;
  visible: boolean;
  type: "string" | "number" | "calculated";
  formula?: string;
}

interface FilterConfig {
  field: string;
  operator: "eq" | "gt" | "lt" | "contains" | "not_empty";
  value: string;
}

interface TransformConfig {
  columns: ColumnConfig[];
  filters: FilterConfig[];
}

interface ODataEntity {
  id: string;
  source_id: string;
  entity_name: string;
  display_name?: string;
  table_name: string;
  last_synced_at?: string;
  last_row_count?: number;
  last_error?: string;
  transform_config?: TransformConfig;
}

interface ODataSource {
  id: string;
  name: string;
  odata_base_url: string;
  auth_base_url?: string;
  username?: string;
  company?: string;
  created_at: string;
  entities: ODataEntity[];
}

export default function AdminPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showAddForm, setShowAddForm] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("standard");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState("");

  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editRole, setEditRole] = useState("standard");
  const [editError, setEditError] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  const [sources, setSources] = useState<ODataSource[]>([]);
  const [showAddSrcForm, setShowAddSrcForm] = useState(false);
  const [srcName, setSrcName] = useState("");
  const [srcODataUrl, setSrcODataUrl] = useState("");
  const [srcAuthUrl, setSrcAuthUrl] = useState("");
  const [srcUser, setSrcUser] = useState("");
  const [srcPw, setSrcPw] = useState("");
  const [srcCo, setSrcCo] = useState("");
  const [addSrcLoading, setAddSrcLoading] = useState(false);
  const [addSrcError, setAddSrcError] = useState("");
  const [browseData, setBrowseData] = useState<Record<string, string[]>>({});
  const [browseLoading, setBrowseLoading] = useState<Record<string, boolean>>({});
  const [entitySel, setEntitySel] = useState<Record<string, Set<string>>>({});
  const [syncingSrc, setSyncingSrc] = useState<Record<string, boolean>>({});
  const [syncSrcMsg, setSyncSrcMsg] = useState<Record<string, string>>({});

  const [configEntity, setConfigEntity] = useState<{ entity: ODataEntity; sourceId: string } | null>(null);
  const [configColumns, setConfigColumns] = useState<ColumnConfig[]>([]);
  const [configFilters, setConfigFilters] = useState<FilterConfig[]>([]);
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [availableFields, setAvailableFields] = useState<string[]>([]);
  const [newCalcName, setNewCalcName] = useState("");
  const [newCalcFormula, setNewCalcFormula] = useState("");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.user) setCurrentUser(d.user);
        else router.push("/");
      });
    loadUsers();
    loadSources();
  }, []);

  async function loadUsers() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/users");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setUsers(data.users || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setAddError("");
    setAddLoading(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setNewUsername(""); setNewPassword(""); setNewRole("standard"); setShowAddForm(false);
      await loadUsers();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setAddLoading(false);
    }
  }

  async function handleDeleteUser(userId: string, username: string) {
    if (!confirm("Delete user \"" + username + "\"? This cannot be undone.")) return;
    try {
      const res = await fetch("/api/admin/users/" + userId, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await loadUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete user");
    }
  }

  function startEdit(user: User) {
    setEditingUser(user); setEditUsername(user.username); setEditPassword(""); setEditRole(user.role); setEditError("");
  }

  async function handleEditUser(e: React.FormEvent) {
    e.preventDefault();
    if (!editingUser) return;
    setEditError(""); setEditLoading(true);
    try {
      const body: Record<string, string> = { username: editUsername, role: editRole };
      if (editPassword) body.password = editPassword;
      const res = await fetch("/api/admin/users/" + editingUser.id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setEditingUser(null);
      await loadUsers();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update user");
    } finally {
      setEditLoading(false);
    }
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  async function loadSources() {
    const res = await fetch("/api/admin/odata-sources");
    const d = await res.json();
    if (d.sources) setSources(d.sources);
  }

  async function handleAddSrc(e: React.FormEvent) {
    e.preventDefault();
    setAddSrcLoading(true);
    setAddSrcError("");
    const res = await fetch("/api/admin/odata-sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: srcName, odata_base_url: srcODataUrl, auth_base_url: srcAuthUrl, username: srcUser, password: srcPw, company: srcCo })
    });
    const d = await res.json();
    if (!res.ok) { setAddSrcError(d.error || "Failed to add source"); }
    else {
      setShowAddSrcForm(false);
      setSrcName(""); setSrcODataUrl(""); setSrcAuthUrl(""); setSrcUser(""); setSrcPw(""); setSrcCo("");
      await loadSources();
    }
    setAddSrcLoading(false);
  }

  async function handleDelSrc(id: string) {
    if (!confirm("Delete this source?")) return;
    await fetch("/api/admin/odata-sources/" + id, { method: "DELETE" });
    await loadSources();
  }

  async function handleBrowse(sourceId: string) {
    setBrowseLoading(p => ({ ...p, [sourceId]: true }));
    const res = await fetch("/api/admin/odata-sources/" + sourceId + "/browse", { method: "POST" });
    const d = await res.json();
    if (d.entities) {
      setBrowseData(p => ({ ...p, [sourceId]: d.entities }));
      const src = sources.find(s => s.id === sourceId);
      if (src) setEntitySel(p => ({ ...p, [sourceId]: new Set(src.entities.map((e: ODataEntity) => e.entity_name)) }));
    }
    setBrowseLoading(p => ({ ...p, [sourceId]: false }));
  }

  async function handleToggleEnt(sourceId: string, entityName: string, selected: boolean) {
    await fetch("/api/admin/odata-sources/" + sourceId + "/entities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_name: entityName, selected })
    });
    setEntitySel(p => {
      const n = new Set(p[sourceId] || []);
      if (selected) n.add(entityName); else n.delete(entityName);
      return { ...p, [sourceId]: n };
    });
    await loadSources();
  }

  async function handleSyncSrc(sourceId: string) {
    setSyncingSrc(p => ({ ...p, [sourceId]: true }));
    setSyncSrcMsg(p => ({ ...p, [sourceId]: "" }));
    const res = await fetch("/api/admin/odata-sources/" + sourceId + "/sync", { method: "POST" });
    const d = await res.json();
    setSyncSrcMsg(p => ({ ...p, [sourceId]: d.message || d.error || "Done" }));
    setSyncingSrc(p => ({ ...p, [sourceId]: false }));
    await loadSources();
  }

  async function handleOpenConfig(sourceId: string, ent: ODataEntity) {
    setConfigEntity({ entity: ent, sourceId });
    setConfigLoading(true);
    setNewCalcName("");
    setNewCalcFormula("");
    try {
      const res = await fetch("/api/admin/odata-sources/" + sourceId + "/entities/" + ent.id + "/transform");
      const d = await res.json();
      const fields: string[] = d.columns || [];
      setAvailableFields(fields);
      const existingConfig: TransformConfig = d.entity?.transform_config || { columns: [], filters: [] };
      if (!existingConfig.columns || existingConfig.columns.length === 0) {
        setConfigColumns(fields.map((field) => ({ field, label: field, visible: true, type: "string" as const })));
      } else {
        setConfigColumns(existingConfig.columns);
      }
      setConfigFilters(existingConfig.filters || []);
    } catch {
      setConfigColumns([]);
      setConfigFilters([]);
    } finally {
      setConfigLoading(false);
    }
  }

  async function handleSaveTransform() {
    if (!configEntity) return;
    setConfigSaving(true);
    try {
      const transform_config: TransformConfig = { columns: configColumns, filters: configFilters };
      const res = await fetch(
        "/api/admin/odata-sources/" + configEntity.sourceId + "/entities/" + configEntity.entity.id + "/transform",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transform_config }),
        }
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setConfigEntity(null);
      await loadSources();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setConfigSaving(false);
    }
  }

  return (
    <div className="flex h-screen bg-gray-100">
      <aside className="w-64 bg-slate-800 flex flex-col flex-shrink-0">
        <div className="px-6 py-5 border-b border-slate-700">
          <h1 className="text-amber-400 font-bold text-lg leading-tight">Job Cost Analyst</h1>
          <p className="text-slate-400 text-xs mt-0.5">Acumatica Integration</p>
        </div>
        <nav className="flex-1 px-4 py-4 space-y-1">
          <a href="/chat" className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-300 hover:bg-slate-700 hover:text-white text-sm font-medium transition">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            Chat
          </a>
          <a href="/admin" className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-slate-700 text-white text-sm font-medium">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
            Admin
          </a>
        </nav>
        <div className="px-4 py-4 border-t border-slate-700">
          {currentUser && (
            <div className="mb-3 px-3">
              <p className="text-white text-sm font-medium">{currentUser.username}</p>
              <p className="text-slate-400 text-xs capitalize">{currentUser.role}</p>
            </div>
          )}
          <button onClick={handleLogout} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-300 hover:bg-slate-700 hover:text-white text-sm font-medium transition">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Sign Out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-800">Admin</h2>
            <p className="text-sm text-gray-500">Manage users and data sources</p>
          </div>
          <button onClick={() => setShowAddForm(!showAddForm)} className="flex items-center gap-2 bg-amber-400 hover:bg-amber-300 text-slate-900 font-semibold rounded-lg px-4 py-2 text-sm transition">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add User
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {error && <p className="text-red-500 mb-4 text-sm">{error}</p>}

          {showAddForm && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
              <h3 className="text-base font-semibold text-gray-800 mb-4">Add New User</h3>
              <form onSubmit={handleAddUser} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
                  <input type="text" required value={newUsername} onChange={(e) => setNewUsername(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" placeholder="username" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                  <input type="password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" placeholder="password" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                  <select value={newRole} onChange={(e) => setNewRole(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400">
                    <option value="standard">Standard</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                {addError && <p className="sm:col-span-2 text-red-500 text-sm">{addError}</p>}
                <div className="sm:col-span-2 flex gap-3">
                  <button type="submit" disabled={addLoading} className="bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-900 font-semibold rounded-lg px-4 py-2 text-sm transition">
                    {addLoading ? "Creating..." : "Create User"}
                  </button>
                  <button type="button" onClick={() => setShowAddForm(false)} className="bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg px-4 py-2 text-sm transition">Cancel</button>
                </div>
              </form>
            </div>
          )}

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-gray-800">Data Sources</h3>
                <p className="text-sm text-gray-500">OData sync configuration</p>
              </div>
              <button onClick={() => setShowAddSrcForm(!showAddSrcForm)} className="flex items-center gap-2 bg-amber-400 hover:bg-amber-300 text-slate-900 font-semibold rounded-lg px-4 py-2 text-sm transition">+ Add Source</button>
            </div>
            {showAddSrcForm && (
              <form onSubmit={handleAddSrc} className="mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="block text-xs font-medium text-gray-600 mb-1">Name</label><input value={srcName} onChange={e => setSrcName(e.target.value)} placeholder="Acumatica" required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" /></div>
                  <div><label className="block text-xs font-medium text-gray-600 mb-1">OData Base URL</label><input value={srcODataUrl} onChange={e => setSrcODataUrl(e.target.value)} placeholder="https://..." required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" /></div>
                  <div><label className="block text-xs font-medium text-gray-600 mb-1">Auth Base URL</label><input value={srcAuthUrl} onChange={e => setSrcAuthUrl(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" /></div>
                  <div><label className="block text-xs font-medium text-gray-600 mb-1">Username</label><input value={srcUser} onChange={e => setSrcUser(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" /></div>
                  <div><label className="block text-xs font-medium text-gray-600 mb-1">Password</label><input type="password" value={srcPw} onChange={e => setSrcPw(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" /></div>
                  <div><label className="block text-xs font-medium text-gray-600 mb-1">Company</label><input value={srcCo} onChange={e => setSrcCo(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" /></div>
                </div>
                {addSrcError && <p className="text-red-500 text-sm">{addSrcError}</p>}
                <div className="flex gap-2">
                  <button type="submit" disabled={addSrcLoading} className="bg-amber-400 hover:bg-amber-300 text-slate-900 font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">{addSrcLoading ? "Adding..." : "Add Source"}</button>
                  <button type="button" onClick={() => setShowAddSrcForm(false)} className="border border-gray-300 rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
                </div>
              </form>
            )}
            {sources.length === 0 && !showAddSrcForm && <p className="text-gray-400 text-sm">No sources configured.</p>}
            <div className="space-y-4">
              {sources.map(source => (
                <div key={source.id} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div><p className="font-semibold text-gray-800">{source.name}</p><p className="text-xs text-gray-500 mt-0.5">{source.odata_base_url}</p></div>
                    <div className="flex gap-2 flex-shrink-0">
                      <button onClick={() => handleBrowse(source.id)} disabled={browseLoading[source.id]} className="text-xs border border-gray-300 rounded-lg px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50">{browseLoading[source.id] ? "Loading..." : "Browse Entities"}</button>
                      <button onClick={() => handleSyncSrc(source.id)} disabled={syncingSrc[source.id]} className="text-xs bg-amber-400 hover:bg-amber-300 text-slate-900 font-semibold rounded-lg px-3 py-1.5 disabled:opacity-50">{syncingSrc[source.id] ? "Syncing..." : "Sync Now"}</button>
                      <button onClick={() => handleDelSrc(source.id)} className="text-xs border border-red-200 text-red-500 rounded-lg px-3 py-1.5 hover:bg-red-50">Delete</button>
                    </div>
                  </div>
                  {syncSrcMsg[source.id] && <p className="text-sm text-gray-600 bg-gray-50 rounded p-2 mb-3">{syncSrcMsg[source.id]}</p>}
                  {browseData[source.id] && (
                    <div className="mb-3">
                      <p className="text-xs font-medium text-gray-600 mb-2">Select entities to sync:</p>
                      <div className="grid grid-cols-3 gap-1.5 max-h-40 overflow-y-auto p-2 bg-gray-50 rounded-lg">
                        {browseData[source.id].map(ent => (
                          <label key={ent} className="flex items-center gap-1.5 text-xs cursor-pointer">
                            <input type="checkbox" checked={(entitySel[source.id] || new Set()).has(ent)} onChange={e => handleToggleEnt(source.id, ent, e.target.checked)} className="rounded border-gray-300" />
                            <span className="text-gray-700 truncate">{ent}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  {source.entities.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-gray-600 mb-2">Synced entities:</p>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-gray-500 border-b border-gray-100">
                            <th className="pb-1 font-medium">Entity</th>
                            <th className="pb-1 font-medium">Rows</th>
                            <th className="pb-1 font-medium">Last Synced</th>
                            <th className="pb-1 font-medium">Status</th>
                            <th className="pb-1 font-medium">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {source.entities.map(ent => (
                            <tr key={ent.id} className="border-b border-gray-50">
                              <td className="py-1.5 text-gray-800">{ent.display_name || ent.entity_name}</td>
                              <td className="py-1.5 text-gray-600">{ent.last_row_count != null ? ent.last_row_count : "â"}</td>
                              <td className="py-1.5 text-gray-500">{ent.last_synced_at ? new Date(ent.last_synced_at).toLocaleString() : "Never"}</td>
                              <td className="py-1.5">{ent.last_error ? <span className="text-red-500">{ent.last_error.slice(0, 40)}</span> : <span className="text-green-500">OK</span>}</td>
                              <td className="py-1.5">
                                <button onClick={() => handleOpenConfig(source.id, ent)} className="text-blue-600 hover:text-blue-800 font-medium text-xs underline">
                                  Configure
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {editingUser && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
              <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
                <h3 className="text-base font-semibold text-gray-800 mb-4">Edit User: {editingUser.username}</h3>
                <form onSubmit={handleEditUser} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
                    <input type="text" required value={editUsername} onChange={(e) => setEditUsername(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">New Password <span className="text-gray-400 font-normal">(leave blank to keep current)</span></label>
                    <input type="password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" placeholder="New password..." />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                    <select value={editRole} onChange={(e) => setEditRole(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400">
                      <option value="standard">Standard</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                  {editError && <p className="text-red-500 text-sm">{editError}</p>}
                  <div className="flex gap-3 pt-2">
                    <button type="submit" disabled={editLoading} className="bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-900 font-semibold rounded-lg px-4 py-2 text-sm transition">
                      {editLoading ? "Saving..." : "Save Changes"}
                    </button>
                    <button type="button" onClick={() => setEditingUser(null)} className="bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg px-4 py-2 text-sm transition">Cancel</button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {configEntity && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-auto">
              <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-screen overflow-auto">
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 sticky top-0 bg-white">
                  <div>
                    <h3 className="text-base font-semibold text-gray-800">
                      Configure: {configEntity.entity.display_name || configEntity.entity.entity_name}
                    </h3>
                    <p className="text-xs text-gray-500 mt-0.5">Column visibility, labels, calculated fields, and row filters</p>
                  </div>
                  <button onClick={() => setConfigEntity(null)} className="text-gray-400 hover:text-gray-600 text-xl font-light leading-none">x</button>
                </div>

                {configLoading ? (
                  <div className="flex items-center justify-center h-40">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-400" />
                  </div>
                ) : (
                  <div className="p-6 space-y-6">
                    <div>
                      <h4 className="text-sm font-semibold text-gray-700 mb-3">Column Configuration</h4>
                      <div className="border border-gray-200 rounded-lg overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-3 py-2 text-left font-medium text-gray-600 w-14">Show</th>
                              <th className="px-3 py-2 text-left font-medium text-gray-600">Field / Formula</th>
                              <th className="px-3 py-2 text-left font-medium text-gray-600">Display Label</th>
                              <th className="px-3 py-2 text-left font-medium text-gray-600 w-28">Type</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {configColumns.map((col, idx) => (
                              <tr key={idx} className={col.visible ? "" : "opacity-50"}>
                                <td className="px-3 py-1.5 text-center">
                                  <input type="checkbox" checked={col.visible} onChange={e => {
                                    const next = [...configColumns];
                                    next[idx] = { ...next[idx], visible: e.target.checked };
                                    setConfigColumns(next);
                                  }} className="rounded border-gray-300" />
                                </td>
                                <td className="px-3 py-1.5">
                                  {col.type === "calculated" ? (
                                    <input type="text" value={col.formula || ""} onChange={e => {
                                      const next = [...configColumns];
                                      next[idx] = { ...next[idx], formula: e.target.value };
                                      setConfigColumns(next);
                                    }} className="border border-gray-300 rounded px-2 py-1 w-full text-xs font-mono" placeholder="e.g. ActualLabor + ActualSubs" />
                                  ) : (
                                    <span className="font-mono text-gray-600">{col.field}</span>
                                  )}
                                </td>
                                <td className="px-3 py-1.5">
                                  <input type="text" value={col.label} onChange={e => {
                                    const next = [...configColumns];
                                    next[idx] = { ...next[idx], label: e.target.value };
                                    setConfigColumns(next);
                                  }} className="border border-gray-300 rounded px-2 py-1 w-full text-xs" />
                                </td>
                                <td className="px-3 py-1.5">
                                  <div className="flex items-center gap-1">
                                    <span className={"inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium " + (col.type === "calculated" ? "bg-purple-100 text-purple-700" : "bg-gray-100 text-gray-600")}>
                                      {col.type}
                                    </span>
                                    {col.type === "calculated" && (
                                      <button onClick={() => setConfigColumns(configColumns.filter((_, i) => i !== idx))} className="text-red-400 hover:text-red-600 font-bold ml-1">x</button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="mt-3 p-3 bg-purple-50 rounded-lg border border-purple-100">
                        <p className="text-xs font-semibold text-purple-700 mb-2">Add Calculated Column</p>
                        <div className="flex gap-2">
                          <input type="text" value={newCalcName} onChange={e => setNewCalcName(e.target.value)} placeholder="Name (e.g. Total Cost)" className="border border-gray-300 rounded px-2 py-1 text-xs w-40" />
                          <input type="text" value={newCalcFormula} onChange={e => setNewCalcFormula(e.target.value)} placeholder="Formula (e.g. ActualLabor + ActualSubs + ActualMaterials)" className="border border-gray-300 rounded px-2 py-1 text-xs flex-1 font-mono" />
                          <button onClick={() => {
                            if (!newCalcName.trim()) return;
                            const field = newCalcName.trim().replace(/\s+/g, "");
                            setConfigColumns([...configColumns, { field, label: newCalcName.trim(), visible: true, type: "calculated", formula: newCalcFormula.trim() }]);
                            setNewCalcName("");
                            setNewCalcFormula("");
                          }} className="bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded px-3 py-1 text-xs whitespace-nowrap">+ Add</button>
                        </div>
                        <p className="text-xs text-purple-500 mt-1.5">Use field names from above. Example: ActualRevenue - ActualLabor - ActualSubs - ActualMaterials - ActualDisposal - ActualOther</p>
                      </div>
                    </div>

                    <div>
                      <h4 className="text-sm font-semibold text-gray-700 mb-3">Row Filters <span className="text-xs font-normal text-gray-400">(combined with AND)</span></h4>
                      <div className="space-y-2">
                        {configFilters.map((filter, idx) => (
                          <div key={idx} className="flex gap-2 items-center">
                            <select value={filter.field} onChange={e => {
                              const next = [...configFilters];
                              next[idx] = { ...next[idx], field: e.target.value };
                              setConfigFilters(next);
                            }} className="border border-gray-300 rounded px-2 py-1 text-xs">
                              {availableFields.map(f => <option key={f} value={f}>{f}</option>)}
                              {configColumns.filter(c => c.type === "calculated").map(c => (
                                <option key={c.field} value={c.field}>{c.label} (calc)</option>
                              ))}
                            </select>
                            <select value={filter.operator} onChange={e => {
                              const next = [...configFilters];
                              next[idx] = { ...next[idx], operator: e.target.value as FilterConfig["operator"] };
                              setConfigFilters(next);
                            }} className="border border-gray-300 rounded px-2 py-1 text-xs">
                              <option value="eq">equals</option>
                              <option value="gt">greater than</option>
                              <option value="lt">less than</option>
                              <option value="contains">contains</option>
                              <option value="not_empty">not empty</option>
                            </select>
                            {filter.operator !== "not_empty" && (
                              <input type="text" value={filter.value} onChange={e => {
                                const next = [...configFilters];
                                next[idx] = { ...next[idx], value: e.target.value };
                                setConfigFilters(next);
                              }} placeholder="Value" className="border border-gray-300 rounded px-2 py-1 text-xs flex-1" />
                            )}
                            <button onClick={() => setConfigFilters(configFilters.filter((_, i) => i !== idx))} className="text-red-400 hover:text-red-600 font-bold">x</button>
                          </div>
                        ))}
                        <button onClick={() => setConfigFilters([...configFilters, { field: availableFields[0] || "", operator: "gt", value: "0" }])} className="text-xs text-blue-600 hover:text-blue-700 font-medium">+ Add Filter</button>
                      </div>
                    </div>

                    <div className="flex gap-3 pt-2 border-t border-gray-200">
                      <button onClick={handleSaveTransform} disabled={configSaving} className="bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-900 font-semibold rounded-lg px-4 py-2 text-sm transition">
                        {configSaving ? "Saving..." : "Save Configuration"}
                      </button>
                      <button onClick={() => setConfigEntity(null)} className="bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg px-4 py-2 text-sm transition">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-base font-semibold text-gray-800">Users</h3>
            </div>
            {loading ? (
              <div className="flex items-center justify-center h-40">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-400" />
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-6 py-3 font-semibold text-gray-600">Username</th>
                    <th className="text-left px-6 py-3 font-semibold text-gray-600">Role</th>
                    <th className="text-left px-6 py-3 font-semibold text-gray-600">Created</th>
                    <th className="text-right px-6 py-3 font-semibold text-gray-600">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {users.length === 0 ? (
                    <tr><td colSpan={4} className="px-6 py-10 text-center text-gray-400">No users found.</td></tr>
                  ) : (
                    users.map((u) => (
                      <tr key={u.id} className="hover:bg-gray-50 transition">
                        <td className="px-6 py-4 font-medium text-gray-800">{u.username}</td>
                        <td className="px-6 py-4">
                          <span className={"inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium " + (u.role === "admin" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-600")}>
                            {u.role}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-gray-500">{formatDate(u.created_at)}</td>
                        <td className="px-6 py-4 text-right">
                          <button onClick={() => startEdit(u)} className="text-blue-600 hover:text-blue-700 font-medium mr-4 transition">Edit</button>
                          <button onClick={() => handleDeleteUser(u.id, u.username)} className="text-red-600 hover:text-red-700 font-medium transition">Delete</button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
