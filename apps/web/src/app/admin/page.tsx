"use client";

// ============================================
// DENGARKAN — Super Admin: Manajemen Akun (/admin)
//
// Compact, Mobile-First Account Management:
//   • Layout 100% konsisten dengan TrackRow (Queue/History)
//   • 4 Field Utama: Nama Akun (Bold), Last Login, Durasi, Perangkat/Browser
//   • CRUD Lengkap: Tambah Akun, Edit Akun, Suspend/Aktifkan, Hapus Akun
//   • Persistensi di localStorage ('dengarkan:admin_accounts')
//   • Touch-friendly popover & dialog untuk iPhone 13 Safari & Chrome
// ============================================

import React, { useState, useEffect, useMemo } from "react";
import type { AdminUserAccount } from "@/services/api-client";

const STORAGE_KEY = "dengarkan:admin_accounts";

const INITIAL_ACCOUNTS: AdminUserAccount[] = [
  {
    id: "acc-1",
    username: "abang",
    role: "user",
    status: "active",
    lastLogin: "10 menit lalu",
    activeDuration: "42 jam",
    device: "iPhone 13 • Safari Mobile",
    createdAt: "2026-01-01",
  },
  {
    id: "acc-2",
    username: "user1",
    role: "user",
    status: "active",
    lastLogin: "2 hari lalu",
    activeDuration: "5 jam",
    device: "Android • Chrome Mobile",
    createdAt: "2026-01-01",
  },
  {
    id: "acc-3",
    username: "maswaw",
    role: "superadmin",
    status: "active",
    lastLogin: "Baru saja",
    activeDuration: "1 jam",
    device: "iPhone 13 • Chrome Mobile",
    createdAt: "2026-01-01",
  },
];

export default function AdminAccountsPage() {
  const [accounts, setAccounts] = useState<AdminUserAccount[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Active Menu popover target
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  // Modals state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<AdminUserAccount | null>(null);
  const [deletingAccount, setDeletingAccount] = useState<AdminUserAccount | null>(null);

  // Form states for Add / Edit
  const [formUsername, setFormUsername] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [formDevice, setFormDevice] = useState("iPhone 13 • Safari Mobile");
  const [formRole, setFormRole] = useState<"user" | "superadmin">("user");
  const [formStatus, setFormStatus] = useState<"active" | "suspended">("active");

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setAccounts(parsed);
          setIsLoaded(true);
          return;
        }
      }
    } catch {
      // Fallback
    }
    setAccounts(INITIAL_ACCOUNTS);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(INITIAL_ACCOUNTS));
    } catch {}
    setIsLoaded(true);
  }, []);

  // Sync to localStorage
  const saveAccounts = (newAccounts: AdminUserAccount[]) => {
    setAccounts(newAccounts);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newAccounts));
    } catch {}
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

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
        acc.device.toLowerCase().includes(q) ||
        acc.role.toLowerCase().includes(q) ||
        acc.status.toLowerCase().includes(q)
    );
  }, [accounts, searchQuery]);

  // Handle Add Account
  const handleOpenAdd = () => {
    setFormUsername("");
    setFormPassword("");
    setFormDevice("iPhone 13 • Safari Mobile");
    setFormRole("user");
    setFormStatus("active");
    setIsAddModalOpen(true);
  };

  const handleSubmitAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUsername = formUsername.trim();
    if (!cleanUsername) return;

    if (accounts.some((a) => a.username.toLowerCase() === cleanUsername.toLowerCase())) {
      alert("Username sudah digunakan. Silakan pilih username lain.");
      return;
    }

    const newAcc: AdminUserAccount = {
      id: `acc-${Date.now()}`,
      username: cleanUsername,
      role: formRole,
      status: formStatus,
      lastLogin: "Belum pernah",
      activeDuration: "0 jam",
      device: formDevice.trim() || "iPhone 13 • Safari Mobile",
      createdAt: new Date().toISOString().split("T")[0],
    };

    saveAccounts([newAcc, ...accounts]);
    setIsAddModalOpen(false);
    showToast(`Akun "${cleanUsername}" berhasil ditambahkan`);
  };

  // Handle Edit Account
  const handleOpenEdit = (acc: AdminUserAccount) => {
    setActiveMenuId(null);
    setEditingAccount(acc);
    setFormUsername(acc.username);
    setFormPassword("");
    setFormDevice(acc.device);
    setFormRole(acc.role);
    setFormStatus(acc.status);
  };

  const handleSubmitEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAccount) return;
    const cleanUsername = formUsername.trim();
    if (!cleanUsername) return;

    // Check duplicate username if changed
    if (
      cleanUsername.toLowerCase() !== editingAccount.username.toLowerCase() &&
      accounts.some((a) => a.username.toLowerCase() === cleanUsername.toLowerCase())
    ) {
      alert("Username sudah digunakan.");
      return;
    }

    const updated = accounts.map((a) => {
      if (a.id === editingAccount.id) {
        return {
          ...a,
          username: cleanUsername,
          role: formRole,
          status: formStatus,
          device: formDevice.trim() || a.device,
        };
      }
      return a;
    });

    saveAccounts(updated);
    setEditingAccount(null);
    showToast(`Akun "${cleanUsername}" berhasil diperbarui`);
  };

  // Handle Toggle Suspend
  const handleToggleSuspend = (acc: AdminUserAccount) => {
    setActiveMenuId(null);
    if (acc.username.toLowerCase() === "maswaw") {
      alert("Akun Super Admin utama tidak dapat ditangguhkan.");
      return;
    }
    const nextStatus: "active" | "suspended" = acc.status === "active" ? "suspended" : "active";
    const updated = accounts.map((a) =>
      a.id === acc.id ? { ...a, status: nextStatus } : a
    );
    saveAccounts(updated);
    showToast(
      nextStatus === "suspended"
        ? `Akun "${acc.username}" ditangguhkan`
        : `Akun "${acc.username}" diaktifkan kembali`
    );
  };

  // Handle Delete
  const handleOpenDelete = (acc: AdminUserAccount) => {
    setActiveMenuId(null);
    if (acc.username.toLowerCase() === "maswaw") {
      alert("Akun Super Admin utama tidak dapat dihapus.");
      return;
    }
    setDeletingAccount(acc);
  };

  const handleConfirmDelete = () => {
    if (!deletingAccount) return;
    const updated = accounts.filter((a) => a.id !== deletingAccount.id);
    saveAccounts(updated);
    showToast(`Akun "${deletingAccount.username}" berhasil dihapus`);
    setDeletingAccount(null);
  };

  if (!isLoaded) {
    return (
      <div className="py-20 flex justify-center">
        <div className="w-5 h-5 border-2 border-[#39FF14] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

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

      {/* Header & Quick Action */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            Manajemen Akun
          </h1>
          <p className="text-xs text-[#8E8E93] mt-0.5">
            Kelola akses, aktivitas login, dan perangkat pengguna
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

      {/* Account List (Identical to TrackRow styling) */}
      <div className="space-y-1.5" role="list">
        {filteredAccounts.length === 0 ? (
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

                  {/* Field 2 & 3: Last Login & Durasi Aktif */}
                  <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[#8E8E93] truncate">
                    <span>Login: {account.lastLogin}</span>
                    <span>•</span>
                    <span>Aktif: {account.activeDuration}</span>
                  </div>

                  {/* Field 4: Perangkat / Browser (Neon accent) */}
                  <div className="mt-0.5 text-[11px] text-[#39FF14]/85 font-mono truncate flex items-center gap-1">
                    <svg className="w-3 h-3 flex-shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                      <line x1="12" y1="18" x2="12.01" y2="18" />
                    </svg>
                    <span>{account.device}</span>
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
                  value={formUsername}
                  onChange={(e) => setFormUsername(e.target.value)}
                  placeholder="misal: user_baru"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#202024] border border-white/10 text-white text-xs focus:outline-none focus:border-[#39FF14]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#8E8E93] uppercase mb-1">
                  Password
                </label>
                <input
                  type="password"
                  required
                  value={formPassword}
                  onChange={(e) => setFormPassword(e.target.value)}
                  placeholder="Masukkan password akun"
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
                  placeholder="misal: iPhone 13 • Safari Mobile"
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
                  className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-[#8E8E93] hover:text-white font-medium text-xs transition-default cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 rounded-xl bg-[#39FF14] hover:bg-[#57FF38] text-black font-bold text-xs transition-default shadow-md glow-brand cursor-pointer"
                >
                  Simpan Akun
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
                  value={formPassword}
                  onChange={(e) => setFormPassword(e.target.value)}
                  placeholder="Kosongkan jika tidak diubah"
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
                  className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-[#8E8E93] hover:text-white font-medium text-xs transition-default cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 rounded-xl bg-[#39FF14] hover:bg-[#57FF38] text-black font-bold text-xs transition-default shadow-md glow-brand cursor-pointer"
                >
                  Perbarui
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
                  Akun <strong className="text-white font-semibold">"{deletingAccount.username}"</strong> akan dihapus permanen dari daftar akses.
                </p>
              </div>
            </div>

            <div className="pt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDeletingAccount(null)}
                className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-[#8E8E93] hover:text-white font-medium text-xs transition-default cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="flex-1 py-2.5 rounded-xl bg-[#FF3B30] hover:bg-[#FF453A] text-white font-bold text-xs transition-default shadow-md cursor-pointer"
              >
                Hapus Permanen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
