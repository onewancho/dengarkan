"use client";

// ============================================
// DENGARKAN — Super Admin: Manajemen Akun (/admin)
//
// Fullstack Database Integrated Account Management:
//   • Layout 100% konsisten dengan TrackRow (Queue/History)
//   • Data bersumber langsung dari Database PostgreSQL via REST API
//   • 4 Field Utama: Nama Akun (Bold), Last Login, Waktu Dibuat, Perangkat/Browser (User-Agent asli)
//   • CRUD Lengkap: Tambah Akun (Argon2id Hashed), Edit Akun, Suspend/Aktifkan, Hapus Akun
//   • Touch-friendly popover & dialog untuk iPhone 13 Safari & Chrome
// ============================================

import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  apiClient,
  type AdminUserAccount,
  type AdminSystemLogEntry,
  type AdminSystemMetrics,
} from "@/services/api-client";

function formatLastLogin(dateStr?: string | null): string {
  if (!dateStr) return "Belum pernah login";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "Belum pernah login";

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return "Baru saja";
  if (diffMinutes < 60) return `${diffMinutes} mnt lalu`;
  if (diffHours < 24) return `${diffHours} jam lalu`;
  if (diffDays < 7) return `${diffDays} hari lalu`;

  return date.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCreatedAt(dateStr?: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatUptime(sec: number): string {
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  if (hours > 0) return `${hours}j ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export default function AdminAccountsPage() {
  const [activeTab, setActiveTab] = useState<"accounts" | "logs">("accounts");

  const [accounts, setAccounts] = useState<AdminUserAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Live System Logs State
  const [logs, setLogs] = useState<AdminSystemLogEntry[]>([]);
  const [metrics, setMetrics] = useState<AdminSystemMetrics | null>(null);
  const [isLogsLoading, setIsLogsLoading] = useState(false);
  const [logLevelFilter, setLogLevelFilter] = useState<"ALL" | "INFO" | "WARN" | "ERROR">("ALL");
  const [autoScroll, setAutoScroll] = useState(true);
  const terminalEndRef = React.useRef<HTMLDivElement>(null);

  // Active Menu popover target
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  // Modals state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<AdminUserAccount | null>(null);
  const [deletingAccount, setDeletingAccount] = useState<AdminUserAccount | null>(null);

  // Form states for Add / Edit
  const [formUsername, setFormUsername] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [formDevice, setFormDevice] = useState("iPhone 13 (Safari)");
  const [formRole, setFormRole] = useState<"user" | "superadmin">("user");
  const [formStatus, setFormStatus] = useState<"active" | "suspended">("active");

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  const extractErrorMessage = (err: unknown, fallback: string): string => {
    if (
      err &&
      typeof err === "object" &&
      "message" in err &&
      typeof (err as { message?: unknown }).message === "string"
    ) {
      return (err as { message: string }).message;
    }
    if (err instanceof Error) {
      return err.message;
    }
    return fallback;
  };

  // Fetch accounts from API
  const fetchAccounts = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient.admin.listUsers();
      setAccounts(res.users);
    } catch (err: unknown) {
      const msg = extractErrorMessage(err, "Gagal memuat daftar pengguna dari server.");
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Fetch system logs from API
  const fetchLogs = useCallback(async () => {
    try {
      const res = await apiClient.admin.getSystemLogs();
      setLogs(res.logs);
      setMetrics(res.metrics);
    } catch {
      // Non-fatal logging fetch error
    } finally {
      setIsLogsLoading(false);
    }
  }, []);

  // Polling logs every 3s when tab is 'logs'
  useEffect(() => {
    if (activeTab !== "logs") return;
    setIsLogsLoading(true);
    fetchLogs();
    const interval = setInterval(fetchLogs, 3000);
    return () => clearInterval(interval);
  }, [activeTab, fetchLogs]);

  // Auto-scroll effect
  useEffect(() => {
    if (autoScroll && activeTab === "logs") {
      terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll, activeTab]);

  // Filter logs by level
  const filteredLogs = useMemo(() => {
    if (logLevelFilter === "ALL") return logs;
    return logs.filter((l) => l.level.toUpperCase() === logLevelFilter);
  }, [logs, logLevelFilter]);

  // Close 3-dots menu on outside click
  useEffect(() => {
    function handleGlobalClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-account-menu]")) {
        setActiveMenuId(null);
      }
    }
    window.addEventListener("click", handleGlobalClick);
    return () => window.removeEventListener("click", handleGlobalClick);
  }, []);

  // Filter accounts
  const filteredAccounts = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return accounts;
    return accounts.filter(
      (acc) =>
        acc.username.toLowerCase().includes(q) ||
        (acc.lastDevice && acc.lastDevice.toLowerCase().includes(q)) ||
        acc.role.toLowerCase().includes(q) ||
        acc.status.toLowerCase().includes(q)
    );
  }, [accounts, searchQuery]);

  // Handle Add Account
  const handleOpenAdd = () => {
    setFormUsername("");
    setFormPassword("");
    setFormDevice("iPhone 13 (Safari)");
    setFormRole("user");
    setFormStatus("active");
    setIsAddModalOpen(true);
  };

  const handleSubmitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUsername = formUsername.trim().toLowerCase();
    const cleanPassword = formPassword.trim();
    if (!cleanUsername || !cleanPassword) return;

    setIsSubmitting(true);
    try {
      const res = await apiClient.admin.createUser({
        username: cleanUsername,
        password: cleanPassword,
        role: formRole,
        status: formStatus,
        device: formDevice.trim() || undefined,
      });

      setAccounts((prev) => [res.user, ...prev]);
      setIsAddModalOpen(false);
      showToast(`Akun "${cleanUsername}" berhasil dibuat di database`);
    } catch (err: unknown) {
      const msg = extractErrorMessage(err, "Gagal membuat akun.");
      alert(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle Edit Account
  const handleOpenEdit = (acc: AdminUserAccount) => {
    setActiveMenuId(null);
    setEditingAccount(acc);
    setFormUsername(acc.username);
    setFormPassword("");
    setFormDevice(acc.lastDevice || "iPhone 13 (Safari)");
    setFormRole(acc.role);
    setFormStatus(acc.status);
  };

  const handleSubmitEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAccount) return;
    const cleanUsername = formUsername.trim().toLowerCase();
    const cleanPassword = formPassword.trim();
    if (!cleanUsername) return;

    setIsSubmitting(true);
    try {
      const res = await apiClient.admin.updateUser(editingAccount.id, {
        username: cleanUsername,
        role: formRole,
        status: formStatus,
        device: formDevice.trim() || undefined,
        ...(cleanPassword ? { password: cleanPassword } : {}),
      });

      setAccounts((prev) =>
        prev.map((a) => (a.id === editingAccount.id ? res.user : a))
      );
      setEditingAccount(null);
      showToast(`Akun "${cleanUsername}" berhasil diperbarui`);
    } catch (err: unknown) {
      const msg = extractErrorMessage(err, "Gagal memperbarui akun.");
      alert(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle Toggle Suspend
  const handleToggleSuspend = async (acc: AdminUserAccount) => {
    setActiveMenuId(null);
    if (acc.username.toLowerCase() === "maswaw") {
      alert("Akun Super Admin utama (maswaw) tidak dapat ditangguhkan.");
      return;
    }
    const nextStatus: "active" | "suspended" = acc.status === "active" ? "suspended" : "active";
    try {
      const res = await apiClient.admin.updateUser(acc.id, { status: nextStatus });
      setAccounts((prev) =>
        prev.map((a) => (a.id === acc.id ? res.user : a))
      );
      showToast(
        nextStatus === "suspended"
          ? `Akun "${acc.username}" ditangguhkan`
          : `Akun "${acc.username}" diaktifkan kembali`
      );
    } catch (err: unknown) {
      const msg = extractErrorMessage(err, "Gagal mengubah status akun.");
      alert(msg);
    }
  };

  // Handle Delete
  const handleOpenDelete = (acc: AdminUserAccount) => {
    setActiveMenuId(null);
    if (acc.username.toLowerCase() === "maswaw") {
      alert("Akun Super Admin utama (maswaw) tidak dapat dihapus.");
      return;
    }
    setDeletingAccount(acc);
  };

  const handleConfirmDelete = async () => {
    if (!deletingAccount) return;
    setIsSubmitting(true);
    try {
      await apiClient.admin.deleteUser(deletingAccount.id);
      setAccounts((prev) => prev.filter((a) => a.id !== deletingAccount.id));
      showToast(`Akun "${deletingAccount.username}" berhasil dihapus dari database`);
      setDeletingAccount(null);
    } catch (err: unknown) {
      const msg = extractErrorMessage(err, "Gagal menghapus akun.");
      alert(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const activeCount = accounts.filter((a) => a.status === "active").length;
  const suspendedCount = accounts.filter((a) => a.status === "suspended").length;

  return (
    <div className="space-y-5 pb-10">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl bg-[#161619] border border-[#39FF14]/40 text-white text-xs font-semibold shadow-2xl flex items-center gap-2 glow-brand transition-all animate-in fade-in slide-in-from-top-3">
          <svg className="w-4 h-4 text-[#39FF14]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex items-center gap-2 p-1 bg-[#161619] border border-white/10 rounded-2xl">
        <button
          onClick={() => setActiveTab("accounts")}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
            activeTab === "accounts"
              ? "bg-white/15 text-white shadow-sm border border-white/15"
              : "text-[#8E8E93] hover:text-white hover:bg-white/5"
          }`}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          <span>Manajemen Akun</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/10 text-white/90">
            {accounts.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab("logs")}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
            activeTab === "logs"
              ? "bg-[#39FF14]/15 text-[#39FF14] shadow-sm border border-[#39FF14]/30 glow-brand"
              : "text-[#8E8E93] hover:text-white hover:bg-white/5"
          }`}
        >
          <div className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#39FF14] opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[#39FF14]"></span>
          </div>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span>Live System Logs</span>
        </button>
      </div>

      {/* ================= VIEW 1: MANAJEMEN AKUN ================= */}
      {activeTab === "accounts" && (
        <div className="space-y-5 animate-in fade-in duration-150">
          {/* Header & Quick Action */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            Manajemen Akun
          </h1>
          <p className="text-xs text-[#8E8E93] mt-0.5">
            Database PostgreSQL • Pelacakan Perangkat Login Otomatis
          </p>
        </div>

        {/* Add Account Button */}
        <button
          onClick={handleOpenAdd}
          className="self-start sm:self-auto px-4 py-2.5 rounded-xl bg-[#39FF14] hover:bg-[#57FF38] active:scale-95 text-black font-bold text-xs tracking-wide transition-all shadow-lg glow-brand flex items-center gap-1.5 cursor-pointer"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>Tambah Akun</span>
        </button>
      </div>

      {/* Stats Chips */}
      <div className="grid grid-cols-3 gap-2">
        <div className="p-3 rounded-xl bg-[#161619] border border-white/5 flex flex-col">
          <span className="text-[10px] text-[#8E8E93] uppercase tracking-wider font-medium">Total Akun</span>
          <span className="text-lg font-bold text-white mt-0.5">{accounts.length}</span>
        </div>
        <div className="p-3 rounded-xl bg-[#161619] border border-white/5 flex flex-col">
          <span className="text-[10px] text-[#8E8E93] uppercase tracking-wider font-medium">Aktif</span>
          <span className="text-lg font-bold text-[#39FF14] mt-0.5">{activeCount}</span>
        </div>
        <div className="p-3 rounded-xl bg-[#161619] border border-white/5 flex flex-col">
          <span className="text-[10px] text-[#8E8E93] uppercase tracking-wider font-medium">Ditangguhkan</span>
          <span className="text-lg font-bold text-[#FF3B30] mt-0.5">{suspendedCount}</span>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Cari nama akun atau perangkat…"
          className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-[#161619] border border-white/10 text-white placeholder-[#8E8E93] text-xs focus:outline-none focus:border-[#39FF14] focus:ring-1 focus:ring-[#39FF14]/30 transition-default"
        />
        <svg
          className="w-4 h-4 absolute left-3 top-3 text-[#8E8E93] pointer-events-none"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            className="absolute right-3 top-2.5 text-[#8E8E93] hover:text-white text-xs p-0.5"
          >
            ✕
          </button>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="p-4 rounded-xl bg-[#FF3B30]/15 border border-[#FF3B30]/30 text-white text-xs flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            onClick={fetchAccounts}
            className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-semibold"
          >
            Coba Lagi
          </button>
        </div>
      )}

      {/* Account List (Identical to TrackRow styling) */}
      <div className="space-y-1.5" role="list">
        {isLoading ? (
          <div className="py-16 flex flex-col items-center justify-center gap-3">
            <div className="w-6 h-6 border-2 border-[#39FF14] border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-[#8E8E93]">Memuat data pengguna dari database…</span>
          </div>
        ) : filteredAccounts.length === 0 ? (
          <div className="text-center py-12 px-4 rounded-xl border border-dashed border-white/10">
            <p className="text-sm text-[#8E8E93]">Tidak ada akun yang sesuai dengan pencarian.</p>
          </div>
        ) : (
          filteredAccounts.map((account) => {
            const isSuspended = account.status === "suspended";
            const isSuper = account.role === "superadmin";
            const initial = account.username.charAt(0).toUpperCase();

            return (
              <div
                key={account.id}
                className="group relative flex items-center gap-2.5 p-2.5 rounded-xl border transition-all duration-150 border-transparent hover:bg-white/5 bg-[#121214]/60"
              >
                {/* Avatar (40px, TrackRow thumbnail equivalent) */}
                <div
                  className={`w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center font-bold text-sm select-none border ${
                    isSuspended
                      ? "bg-[#291414] border-[#FF3B30]/30 text-[#FF3B30]"
                      : isSuper
                      ? "bg-[#142614] border-[#39FF14]/40 text-[#39FF14] shadow-sm glow-brand"
                      : "bg-[#18181b] border-white/10 text-white"
                  }`}
                >
                  {initial}
                </div>

                {/* Account Details (4 required fields) */}
                <div className="flex-1 min-w-0 pr-1">
                  {/* Field 1: Nama Akun (Bold/Besar) + Role/Status Badges */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-semibold text-white truncate max-w-[130px] sm:max-w-xs">
                      {account.username}
                    </span>

                    {isSuper && (
                      <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-[#39FF14]/15 border border-[#39FF14]/30 text-[#39FF14]">
                        SUPER ADMIN
                      </span>
                    )}

                    {isSuspended ? (
                      <span className="text-[9px] font-medium px-1.5 py-0.2 rounded bg-[#FF3B30]/20 border border-[#FF3B30]/30 text-[#FF3B30]">
                        Ditangguhkan
                      </span>
                    ) : (
                      <span className="text-[9px] font-medium px-1.5 py-0.2 rounded bg-white/10 text-[#8E8E93]">
                        Aktif
                      </span>
                    )}
                  </div>

                  {/* Field 2 & 3: Last Login & Dibuat Pada */}
                  <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[#8E8E93] truncate">
                    <span>Login: {formatLastLogin(account.lastLogin)}</span>
                    <span>•</span>
                    <span>Dibuat: {formatCreatedAt(account.createdAt)}</span>
                  </div>

                  {/* Field 4: Perangkat / Browser (User-Agent asli dari database) */}
                  <div className="mt-0.5 text-[11px] text-[#39FF14]/85 font-mono truncate flex items-center gap-1">
                    <svg className="w-3 h-3 flex-shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                      <line x1="12" y1="18" x2="12.01" y2="18" />
                    </svg>
                    <span>{account.lastDevice || "Belum ada riwayat perangkat"}</span>
                  </div>
                </div>

                {/* 3-Dots Action Menu */}
                <div className="relative flex-shrink-0" data-account-menu>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveMenuId(activeMenuId === account.id ? null : account.id);
                    }}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-[#8E8E93] hover:text-white hover:bg-white/10 active:scale-95 transition-default cursor-pointer"
                    aria-label={`Menu aksi untuk ${account.username}`}
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5" r="1.75" />
                      <circle cx="12" cy="12" r="1.75" />
                      <circle cx="12" cy="19" r="1.75" />
                    </svg>
                  </button>

                  {/* Action Menu Popover */}
                  {activeMenuId === account.id && (
                    <div className="absolute right-0 top-9 z-40 w-44 rounded-xl bg-[#1C1C1E] border border-white/10 shadow-2xl py-1 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-100">
                      {/* 1. Edit Akun */}
                      <button
                        onClick={() => handleOpenEdit(account)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-white hover:bg-white/10 text-left transition-default cursor-pointer"
                      >
                        <svg className="w-3.5 h-3.5 text-[#39FF14]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                        </svg>
                        <span>Edit Akun</span>
                      </button>

                      {/* 2. Suspend / Aktifkan Akun */}
                      <button
                        onClick={() => handleToggleSuspend(account)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-white hover:bg-white/10 text-left transition-default cursor-pointer"
                      >
                        {account.status === "active" ? (
                          <>
                            <svg className="w-3.5 h-3.5 text-[#FF9500]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="12" cy="12" r="10" />
                              <line x1="10" y1="15" x2="10" y2="9" />
                              <line x1="14" y1="15" x2="14" y2="9" />
                            </svg>
                            <span>Suspend Akun</span>
                          </>
                        ) : (
                          <>
                            <svg className="w-3.5 h-3.5 text-[#39FF14]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polygon points="5 3 19 12 5 21 5 3" />
                            </svg>
                            <span>Aktifkan Akun</span>
                          </>
                        )}
                      </button>

                      <div className="h-px bg-white/10 my-1" />

                      {/* 3. Delete Akun */}
                      <button
                        onClick={() => handleOpenDelete(account)}
                        disabled={account.username.toLowerCase() === "maswaw"}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-[#FF3B30] hover:bg-[#FF3B30]/15 text-left transition-default cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                        <span>Hapus Akun</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
        </div>
      )}

      {/* ================= VIEW 2: LIVE SYSTEM LOGS ================= */}
      {activeTab === "logs" && (
        <div className="space-y-4 animate-in fade-in duration-200">
          {/* Header & Status Indicator */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2 font-mono">
                <span className="w-2.5 h-2.5 rounded-full bg-[#39FF14] glow-brand animate-pulse" />
                Live System Logs
              </h1>
              <p className="text-xs text-[#8E8E93] mt-0.5">
                In-Memory Ring Buffer (RAM) • Pemantauan Real-time 0% Disk I/O
              </p>
            </div>

            {/* Live Polling Status Badge */}
            <div className="flex items-center gap-2 self-start sm:self-auto px-3 py-1.5 rounded-xl bg-[#161619] border border-white/10 text-xs">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#39FF14] opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#39FF14]"></span>
              </span>
              <span className="text-[#39FF14] font-mono text-[11px] font-semibold">
                Polling Aktif (3s)
              </span>
            </div>
          </div>

          {/* System Metrics Chips */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="p-3 rounded-xl bg-[#161619] border border-white/5 flex flex-col">
              <span className="text-[10px] text-[#8E8E93] uppercase tracking-wider font-medium">Node Heap</span>
              <span className="text-sm font-bold font-mono text-white mt-0.5">
                {metrics ? `${metrics.heapUsedMb} MB / ${metrics.heapTotalMb} MB` : "—"}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-[#161619] border border-white/5 flex flex-col">
              <span className="text-[10px] text-[#8E8E93] uppercase tracking-wider font-medium">Process RSS</span>
              <span className="text-sm font-bold font-mono text-[#39FF14] mt-0.5">
                {metrics ? `${metrics.rssMb} MB` : "—"}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-[#161619] border border-white/5 flex flex-col">
              <span className="text-[10px] text-[#8E8E93] uppercase tracking-wider font-medium">Server Uptime</span>
              <span className="text-sm font-bold font-mono text-cyan-400 mt-0.5">
                {metrics ? formatUptime(metrics.uptimeSec) : "—"}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-[#161619] border border-white/5 flex flex-col">
              <span className="text-[10px] text-[#8E8E93] uppercase tracking-wider font-medium">Total Baris</span>
              <span className="text-sm font-bold font-mono text-white mt-0.5">
                {logs.length} / 500
              </span>
            </div>
          </div>

          {/* Controls Bar: Filter, AutoScroll & Refresh */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 p-2 rounded-xl bg-[#161619] border border-white/10">
            {/* Filter buttons */}
            <div className="flex items-center gap-1">
              {(["ALL", "INFO", "WARN", "ERROR"] as const).map((lvl) => (
                <button
                  key={lvl}
                  onClick={() => setLogLevelFilter(lvl)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-mono font-semibold transition-all cursor-pointer ${
                    logLevelFilter === lvl
                      ? lvl === "ERROR"
                        ? "bg-[#FF3B30]/25 text-[#FF3B30] border border-[#FF3B30]/40"
                        : lvl === "WARN"
                        ? "bg-[#FFCC00]/25 text-[#FFCC00] border border-[#FFCC00]/40"
                        : "bg-[#39FF14]/20 text-[#39FF14] border border-[#39FF14]/30"
                      : "text-[#8E8E93] hover:text-white hover:bg-white/5"
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>

            {/* Right action controls */}
            <div className="flex items-center gap-2">
              {/* Auto Scroll Toggle */}
              <button
                onClick={() => setAutoScroll(!autoScroll)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-mono transition-all cursor-pointer border ${
                  autoScroll
                    ? "bg-[#39FF14]/15 border-[#39FF14]/30 text-[#39FF14]"
                    : "bg-white/5 border-white/10 text-[#8E8E93] hover:text-white"
                }`}
                title="Scroll otomatis saat ada log baru"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="7 13 12 18 17 13" />
                  <polyline points="7 6 12 11 17 6" />
                </svg>
                <span>Auto-scroll: {autoScroll ? "ON" : "OFF"}</span>
              </button>

              {/* Refresh Button */}
              <button
                onClick={fetchLogs}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-[#8E8E93] hover:text-white text-[11px] font-mono transition-default cursor-pointer"
                title="Refresh log manual"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                </svg>
              </button>
            </div>
          </div>

          {/* Terminal Box */}
          <div className="relative rounded-2xl bg-[#08080A] border border-white/15 shadow-2xl overflow-hidden">
            {/* Terminal Window Header */}
            <div className="flex items-center justify-between px-4 py-2.5 bg-[#121215] border-b border-white/10">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-[#FF5F56]" />
                <span className="w-2.5 h-2.5 rounded-full bg-[#FFBD2E]" />
                <span className="w-2.5 h-2.5 rounded-full bg-[#27C93F]" />
                <span className="text-[11px] text-[#8E8E93] font-mono ml-2">dengarkan-server-logs ~ ring-buffer</span>
              </div>
              <span className="text-[10px] text-[#8E8E93] font-mono">
                {filteredLogs.length} entri ditampilkan
              </span>
            </div>

            {/* Terminal Body */}
            <div className="p-3.5 sm:p-4 max-h-[480px] min-h-[300px] overflow-y-auto font-mono text-[11px] leading-relaxed space-y-1.5 select-text">
              {isLogsLoading && logs.length === 0 ? (
                <div className="py-12 flex flex-col items-center justify-center gap-2 text-[#8E8E93]">
                  <div className="w-5 h-5 border-2 border-[#39FF14] border-t-transparent rounded-full animate-spin" />
                  <span>Menghubungkan ke in-memory logger...</span>
                </div>
              ) : filteredLogs.length === 0 ? (
                <div className="py-12 text-center text-[#8E8E93]">
                  <span>Tidak ada log untuk filter "{logLevelFilter}".</span>
                </div>
              ) : (
                filteredLogs.map((entry) => {
                  const isErr = entry.level === "error";
                  const isWarn = entry.level === "warn";

                  return (
                    <div
                      key={entry.id}
                      className={`flex items-start gap-2 py-0.5 px-1 rounded transition-colors ${
                        isErr
                          ? "bg-[#FF3B30]/10 text-red-300"
                          : isWarn
                          ? "bg-[#FFCC00]/10 text-yellow-200"
                          : "hover:bg-white/5 text-gray-200"
                      }`}
                    >
                      {/* Timestamp */}
                      <span className="text-[#6C6C70] flex-shrink-0 select-none">
                        [{entry.timestamp}]
                      </span>

                      {/* Level Badge */}
                      <span
                        className={`flex-shrink-0 px-1.5 py-0.2 rounded text-[9px] font-bold uppercase select-none ${
                          isErr
                            ? "bg-[#FF3B30]/20 text-[#FF3B30] border border-[#FF3B30]/40"
                            : isWarn
                            ? "bg-[#FFCC00]/20 text-[#FFCC00] border border-[#FFCC00]/40"
                            : "bg-[#39FF14]/15 text-[#39FF14] border border-[#39FF14]/30"
                        }`}
                      >
                        {entry.level}
                      </span>

                      {/* Tag Badge */}
                      <span
                        className={`flex-shrink-0 font-bold ${
                          entry.tag === "AUDIO_ROUTING"
                            ? "text-purple-400"
                            : entry.tag === "YTDLP"
                            ? "text-sky-400"
                            : entry.tag === "TRENDING"
                            ? "text-emerald-400"
                            : "text-[#8E8E93]"
                        }`}
                      >
                        [{entry.tag}]
                      </span>

                      {/* Message */}
                      <span className="flex-1 break-all font-mono">
                        {entry.message}
                      </span>
                    </div>
                  );
                })
              )}
              <div ref={terminalEndRef} />
            </div>
          </div>
        </div>
      )}

      {/* ================= MODAL: TAMBAH AKUN ================= */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-sm rounded-2xl bg-[#161619] border border-white/15 p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#39FF14] glow-brand" />
                Tambah Akun Baru
              </h3>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-[#8E8E93] hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitAdd} className="space-y-3.5">
              <div>
                <label className="block text-[11px] font-medium text-[#8E8E93] uppercase mb-1">
                  Username
                </label>
                <input
                  type="text"
                  required
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={formUsername}
                  onChange={(e) => setFormUsername(e.target.value)}
                  placeholder="misal: abang_baru"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#202024] border border-white/10 text-white text-xs focus:outline-none focus:border-[#39FF14]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#8E8E93] uppercase mb-1">
                  Password (Akan di-hash Argon2id di Server)
                </label>
                <input
                  type="password"
                  required
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={formPassword}
                  onChange={(e) => setFormPassword(e.target.value)}
                  placeholder="Masukkan password akun"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#202024] border border-white/10 text-white text-xs focus:outline-none focus:border-[#39FF14]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#8E8E93] uppercase mb-1">
                  Perangkat / Deskripsi Awal
                </label>
                <input
                  type="text"
                  value={formDevice}
                  onChange={(e) => setFormDevice(e.target.value)}
                  placeholder="misal: iPhone 13 (Safari)"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#202024] border border-white/10 text-white text-xs focus:outline-none focus:border-[#39FF14]"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-medium text-[#8E8E93] uppercase mb-1">
                    Role
                  </label>
                  <select
                    value={formRole}
                    onChange={(e) => setFormRole(e.target.value as "user" | "superadmin")}
                    className="w-full px-3 py-2 rounded-xl bg-[#202024] border border-white/10 text-white text-xs focus:outline-none focus:border-[#39FF14]"
                  >
                    <option value="user">User Biasa</option>
                    <option value="superadmin">Super Admin</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-[#8E8E93] uppercase mb-1">
                    Status
                  </label>
                  <select
                    value={formStatus}
                    onChange={(e) => setFormStatus(e.target.value as "active" | "suspended")}
                    className="w-full px-3 py-2 rounded-xl bg-[#202024] border border-white/10 text-white text-xs focus:outline-none focus:border-[#39FF14]"
                  >
                    <option value="active">Aktif</option>
                    <option value="suspended">Ditangguhkan</option>
                  </select>
                </div>
              </div>

              <div className="pt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  disabled={isSubmitting}
                  className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-[#8E8E93] hover:text-white font-medium text-xs transition-default cursor-pointer disabled:opacity-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 py-2.5 rounded-xl bg-[#39FF14] hover:bg-[#57FF38] text-black font-bold text-xs transition-default shadow-md glow-brand cursor-pointer disabled:opacity-50"
                >
                  {isSubmitting ? "Menyimpan…" : "Simpan ke DB"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= MODAL: EDIT AKUN ================= */}
      {editingAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-sm rounded-2xl bg-[#161619] border border-white/15 p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#39FF14]" />
                Edit Akun: {editingAccount.username}
              </h3>
              <button
                onClick={() => setEditingAccount(null)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-[#8E8E93] hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitEdit} className="space-y-3.5">
              <div>
                <label className="block text-[11px] font-medium text-[#8E8E93] uppercase mb-1">
                  Nama Akun
                </label>
                <input
                  type="text"
                  required
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={formUsername}
                  onChange={(e) => setFormUsername(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#202024] border border-white/10 text-white text-xs focus:outline-none focus:border-[#39FF14]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#8E8E93] uppercase mb-1">
                  Reset Password (opsional)
                </label>
                <input
                  type="password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={formPassword}
                  onChange={(e) => setFormPassword(e.target.value)}
                  placeholder="Kosongkan jika tidak ingin mengubah"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#202024] border border-white/10 text-white text-xs focus:outline-none focus:border-[#39FF14]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#8E8E93] uppercase mb-1">
                  Perangkat / Browser
                </label>
                <input
                  type="text"
                  value={formDevice}
                  onChange={(e) => setFormDevice(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#202024] border border-white/10 text-white text-xs focus:outline-none focus:border-[#39FF14]"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-medium text-[#8E8E93] uppercase mb-1">
                    Role
                  </label>
                  <select
                    value={formRole}
                    onChange={(e) => setFormRole(e.target.value as "user" | "superadmin")}
                    className="w-full px-3 py-2 rounded-xl bg-[#202024] border border-white/10 text-white text-xs focus:outline-none focus:border-[#39FF14]"
                  >
                    <option value="user">User Biasa</option>
                    <option value="superadmin">Super Admin</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-[#8E8E93] uppercase mb-1">
                    Status
                  </label>
                  <select
                    value={formStatus}
                    onChange={(e) => setFormStatus(e.target.value as "active" | "suspended")}
                    className="w-full px-3 py-2 rounded-xl bg-[#202024] border border-white/10 text-white text-xs focus:outline-none focus:border-[#39FF14]"
                  >
                    <option value="active">Aktif</option>
                    <option value="suspended">Ditangguhkan</option>
                  </select>
                </div>
              </div>

              <div className="pt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditingAccount(null)}
                  disabled={isSubmitting}
                  className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-[#8E8E93] hover:text-white font-medium text-xs transition-default cursor-pointer disabled:opacity-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 py-2.5 rounded-xl bg-[#39FF14] hover:bg-[#57FF38] text-black font-bold text-xs transition-default shadow-md glow-brand cursor-pointer disabled:opacity-50"
                >
                  {isSubmitting ? "Menyimpan…" : "Perbarui DB"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= MODAL: KONFIRMASI HAPUS ================= */}
      {deletingAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-sm rounded-2xl bg-[#161619] border border-[#FF3B30]/30 p-5 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#FF3B30]/15 flex items-center justify-center text-[#FF3B30] flex-shrink-0">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">Hapus Akun Pengguna?</h3>
                <p className="text-xs text-[#8E8E93] mt-0.5">
                  Akun <strong className="text-white font-semibold">"{deletingAccount.username}"</strong> akan dihapus permanen dari database.
                </p>
              </div>
            </div>

            <div className="pt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDeletingAccount(null)}
                disabled={isSubmitting}
                className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-[#8E8E93] hover:text-white font-medium text-xs transition-default cursor-pointer disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isSubmitting}
                className="flex-1 py-2.5 rounded-xl bg-[#FF3B30] hover:bg-[#FF453A] text-white font-bold text-xs transition-default shadow-md cursor-pointer disabled:opacity-50"
              >
                {isSubmitting ? "Menghapus…" : "Hapus Permanen"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
