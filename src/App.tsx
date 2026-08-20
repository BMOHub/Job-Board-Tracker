import React, { useState, useEffect, useMemo } from 'react';
import { 
  collection, 
  onSnapshot, 
  query, 
  orderBy, 
  addDoc, 
  serverTimestamp, 
  getDocs, 
  where, 
  setDoc, 
  doc, 
  limit, 
  deleteDoc 
} from 'firebase/firestore';
import { 
  Search, 
  RefreshCw, 
  ExternalLink, 
  Calendar, 
  Building2, 
  MapPin, 
  Download, 
  Filter,
  CheckCircle2, 
  AlertCircle, 
  Clock, 
  Briefcase, 
  Mail, 
  Phone, 
  Info, 
  UserPlus, 
  Edit2, 
  Save, 
  X,
  Lock,
  Unlock,
  KeyRound,
  Eye,
  EyeOff,
  Compass,
  Zap,
  Layers
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { db } from './lib/firebase';
import { INITIAL_EMPLOYERS } from './constants';
import { scanJobsForEmployer, isGeminiConfigured } from './services/jobScanner';

const ADMIN_PASSWORD = "twcWR2026";

interface Employer {
  id: string;
  name: string;
  category: string;
  website?: string;
  lastScanned?: any;
  contactPerson?: string;
  contactEmail?: string;
  contactPhone?: string;
  specialistNotes?: string;
}

interface JobPosting {
  id: string;
  employerId: string;
  employerName: string;
  title: string;
  location?: string;
  city?: string;
  roleType?: string;
  url: string;
  postedDate?: any;
  foundDate: any;
  description?: string;
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [employers, setEmployers] = useState<Employer[]>([]);
  const [jobs, setJobs] = useState<JobPosting[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedRoleType, setSelectedRoleType] = useState('All');
  const [selectedCity, setSelectedCity] = useState('All');
  const [selectedTimeframe, setSelectedTimeframe] = useState<'7d' | '14d' | '30d' | 'all'>('30d');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'employer' | 'title'>('newest');
  const [activeTab, setActiveTab] = useState<'jobs' | 'employers'>('jobs');
  const [isScanning, setIsScanning] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showEmployerModal, setShowEmployerModal] = useState(false);
  const [editingEmployer, setEditingEmployer] = useState<Employer | null>(null);
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number; employer: string; category?: string }>({ current: 0, total: 0, employer: '' });
  const [cooldownCountdown, setCooldownCountdown] = useState<number | null>(null);
  const [apiConfigured, setApiConfigured] = useState<boolean>(true);
  const abortControllerRef = useMemo(() => ({ current: false }), []);

  // Admin Password Protection State
  const [isAdminUnlocked, setIsAdminUnlocked] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('twc_admin_unlocked') === 'true';
    } catch {
      return false;
    }
  });
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [showPasswordText, setShowPasswordText] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [pendingAdminAction, setPendingAdminAction] = useState<(() => void) | null>(null);

  // Helper to guard administrative edit actions
  const requireAdmin = (action: () => void) => {
    if (isAdminUnlocked) {
      action();
    } else {
      setPendingAdminAction(() => action);
      setPasswordInput('');
      setPasswordError(null);
      setShowPasswordModal(true);
    }
  };

  const handleVerifyPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordInput === ADMIN_PASSWORD) {
      setIsAdminUnlocked(true);
      try {
        sessionStorage.setItem('twc_admin_unlocked', 'true');
      } catch {}
      setShowPasswordModal(false);
      setPasswordInput('');
      setPasswordError(null);
      if (pendingAdminAction) {
        pendingAdminAction();
        setPendingAdminAction(null);
      }
    } else {
      setPasswordError("Incorrect password. Please enter the valid admin password.");
    }
  };

  const handleLockAdmin = () => {
    setIsAdminUnlocked(false);
    try {
      sessionStorage.removeItem('twc_admin_unlocked');
    } catch {}
  };

  // Dynamic API configuration check from backend status
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch("/api/gemini-status");
        if (res.ok) {
          const data = await res.json();
          setApiConfigured(data.configured);
        } else {
          setApiConfigured(isGeminiConfigured());
        }
      } catch (e) {
        setApiConfigured(isGeminiConfigured());
      }
    };
    checkStatus();
  }, []);

  // Data Listeners
  useEffect(() => {
    const qEmployers = query(collection(db, 'employers'), orderBy('name'));
    const unsubscribeEmployers = onSnapshot(qEmployers, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Employer));
      setEmployers(data);
      setLoading(false);
      
      // Seed if empty
      if (data.length === 0) {
        seedEmployers();
      }
    }, (error) => {
      console.error("Firestore Listeners Failed:", error);
      setFatalError(error.message || "Failed to connect to database. Check your internet or configuration.");
      setLoading(false);
    });

    const qJobs = query(collection(db, 'jobPostings'), orderBy('foundDate', 'desc'), limit(250));
    const unsubscribeJobs = onSnapshot(qJobs, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as JobPosting));
      setJobs(data);
    }, (error) => {
      console.error("Jobs Listener Failed:", error);
    });

    return () => {
      unsubscribeEmployers();
      unsubscribeJobs();
    };
  }, []);

  const seedEmployers = async () => {
    try {
      for (const emp of INITIAL_EMPLOYERS) {
        await addDoc(collection(db, 'employers'), {
          ...emp,
          lastScanned: null
        });
      }
    } catch (error) {
      console.error("Error seeding employers:", error);
    }
  };

  const handleSaveEmployer = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!isAdminUnlocked) {
      setShowPasswordModal(true);
      return;
    }

    const formData = new FormData(e.currentTarget);
    const employerData = {
      name: formData.get('name') as string,
      category: formData.get('category') as string,
      website: formData.get('website') as string,
      contactPerson: formData.get('contactPerson') as string,
      contactEmail: formData.get('contactEmail') as string,
      contactPhone: formData.get('contactPhone') as string,
      specialistNotes: formData.get('specialistNotes') as string,
    };

    try {
      if (editingEmployer) {
        await setDoc(doc(db, 'employers', editingEmployer.id), employerData, { merge: true });
      } else {
        await addDoc(collection(db, 'employers'), {
          ...employerData,
          lastScanned: null
        });
      }
      setShowEmployerModal(false);
      setEditingEmployer(null);
    } catch (error) {
      console.error("Error saving employer:", error);
    }
  };

  const clearAllJobs = async () => {
    if (!isAdminUnlocked) {
      setShowClearConfirm(false);
      requireAdmin(() => setShowClearConfirm(true));
      return;
    }

    setShowClearConfirm(false);
    try {
      const q = query(collection(db, 'jobPostings'));
      const snapshot = await getDocs(q);
      const promises = snapshot.docs.map(d => deleteDoc(doc(db, 'jobPostings', d.id)));
      await Promise.all(promises);
    } catch (error) {
      console.error("Error clearing jobs:", error);
    }
  };

  const scanAll = async (mode: 'all' | 'unscanned' | 'category' = 'unscanned', categoryName?: string) => {
    if (isScanning) return;

    let targetEmployers: Employer[] = [];
    let scanScopeTitle = '';

    if (mode === 'category') {
      const cat = categoryName || selectedCategory;
      if (!cat || cat === 'All') {
        setScanError("Please select a specific industry category to scan.");
        return;
      }
      targetEmployers = employers.filter(e => e.category === cat);
      scanScopeTitle = `${cat} (${targetEmployers.length} partners)`;
    } else if (mode === 'unscanned') {
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      targetEmployers = employers.filter(e => {
        if (!e.lastScanned) return true;
        const millis = e.lastScanned?.toMillis ? e.lastScanned.toMillis() : (e.lastScanned?.getTime ? e.lastScanned.getTime() : 0);
        return millis < oneDayAgo;
      });
      scanScopeTitle = `New / Outdated (${targetEmployers.length} partners)`;
    } else {
      targetEmployers = employers;
      scanScopeTitle = `All (${targetEmployers.length} partners)`;
    }

    if (targetEmployers.length === 0) {
      if (mode === 'category') {
        setScanError(`No employer partners found under "${categoryName || selectedCategory}".`);
      } else {
        setScanError("All employer partners have already been scanned within the past 24 hours. You can click 'Scan All (44)' or select a specific category to scan.");
      }
      return;
    }

    setIsScanning(true);
    setScanError(null);
    abortControllerRef.current = false;
    setScanProgress({ 
      current: 0, 
      total: targetEmployers.length, 
      employer: '', 
      category: mode === 'category' ? (categoryName || selectedCategory) : undefined 
    });

    let scanFailedCount = 0;
    let totalNewJobsAdded = 0;

    for (let i = 0; i < targetEmployers.length; i++) {
      if (abortControllerRef.current) break;
      
      const employer = targetEmployers[i];
      setScanProgress({ 
        current: i + 1, 
        total: targetEmployers.length, 
        employer: employer.name,
        category: mode === 'category' ? (categoryName || selectedCategory) : undefined 
      });
      
      let retryCount = 0;
      let success = false;

      while (!success && retryCount < 2 && !abortControllerRef.current) {
        try {
          const foundJobs = await scanJobsForEmployer(employer.name, employer.website || '');
          let employerNewJobs = 0;
          
          for (const job of foundJobs) {
            if (abortControllerRef.current) break;

            // Duplicate check: URL or (Title + Employer)
            const qUrl = query(collection(db, 'jobPostings'), where('url', '==', job.url));
            const qTitle = query(collection(db, 'jobPostings'), 
              where('employerId', '==', employer.id),
              where('title', '==', job.title)
            );
            
            const [existingUrl, existingTitle] = await Promise.all([
              getDocs(qUrl),
              getDocs(qTitle)
            ]);
            
            if (existingUrl.empty && existingTitle.empty) {
              const postedDate = job.postedDate ? new Date(job.postedDate) : null;
              const validPostedDate = (postedDate && !isNaN(postedDate.getTime())) ? postedDate : null;

              await addDoc(collection(db, 'jobPostings'), {
                employerId: employer.id,
                employerName: employer.name,
                title: job.title,
                location: job.location || 'Philadelphia, PA',
                city: job.city || 'Philadelphia',
                roleType: job.roleType || 'Full-time',
                url: job.url,
                postedDate: validPostedDate,
                foundDate: serverTimestamp(),
                description: job.description || ''
              });
              employerNewJobs++;
              totalNewJobsAdded++;
            }
          }

          await setDoc(doc(db, 'employers', employer.id), {
            lastScanned: serverTimestamp()
          }, { merge: true });

          success = true;

        } catch (error: any) {
          const errMsg = error?.message || String(error);
          const isRateLimit = errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota") || errMsg.includes("rate limit");

          if (isRateLimit && retryCount < 1 && !abortControllerRef.current) {
            retryCount++;
            console.warn(`[API Pacing] Pausing 8s before retrying ${employer.name}...`);
            for (let c = 8; c > 0; c--) {
              if (abortControllerRef.current) break;
              setCooldownCountdown(c);
              await new Promise(r => setTimeout(r, 1000));
            }
            setCooldownCountdown(null);
            continue;
          }

          console.error(`Error scanning ${employer.name}:`, error);
          scanFailedCount++;
          setScanError(`Scan notice: ${employer.name} had a temporary timeout. Continuing with remaining partners...`);
          break;
        }
      }

      // Safe, brisk inter-request pacing: 2.5 seconds between employers
      if (i < targetEmployers.length - 1 && !abortControllerRef.current) {
        await new Promise(r => setTimeout(r, 2500));
      }
    }

    setCooldownCountdown(null);
    if (scanFailedCount === 0) {
      setScanError(null);
    }
    setIsScanning(false);
    setScanProgress({ current: 0, total: 0, employer: '' });
  };

  const scanEmployer = async (employer: Employer) => {
    if (isScanning) return;
    setIsScanning(true);
    setScanError(null);
    abortControllerRef.current = false;
    setScanProgress({ current: 1, total: 1, employer: employer.name });

    let retryCount = 0;
    let success = false;
    let newJobsCount = 0;

    while (!success && retryCount < 2 && !abortControllerRef.current) {
      try {
        const foundJobs = await scanJobsForEmployer(employer.name, employer.website || '');
        
        for (const job of foundJobs) {
          if (abortControllerRef.current) break;

          const qUrl = query(collection(db, 'jobPostings'), where('url', '==', job.url));
          const qTitle = query(collection(db, 'jobPostings'), 
            where('employerId', '==', employer.id),
            where('title', '==', job.title)
          );
          
          const [existingUrl, existingTitle] = await Promise.all([
            getDocs(qUrl),
            getDocs(qTitle)
          ]);
          
          if (existingUrl.empty && existingTitle.empty) {
            const postedDate = job.postedDate ? new Date(job.postedDate) : null;
            const validPostedDate = (postedDate && !isNaN(postedDate.getTime())) ? postedDate : null;

            await addDoc(collection(db, 'jobPostings'), {
              employerId: employer.id,
              employerName: employer.name,
              title: job.title,
              location: job.location || 'Philadelphia, PA',
              city: job.city || 'Philadelphia',
              roleType: job.roleType || 'Full-time',
              url: job.url,
              postedDate: validPostedDate,
              foundDate: serverTimestamp(),
              description: job.description || ''
            });
            newJobsCount++;
          }
        }

        await setDoc(doc(db, 'employers', employer.id), {
          lastScanned: serverTimestamp()
        }, { merge: true });

        success = true;

      } catch (error: any) {
        const errMsg = error?.message || String(error);
        const isRateLimit = errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota");

        if (isRateLimit && retryCount < 1 && !abortControllerRef.current) {
          retryCount++;
          console.warn(`[API Pacing] Pausing 8s before retrying ${employer.name}...`);
          for (let c = 8; c > 0; c--) {
            if (abortControllerRef.current) break;
            setCooldownCountdown(c);
            await new Promise(r => setTimeout(r, 1000));
          }
          setCooldownCountdown(null);
          continue;
        }

        console.error(`Error scanning ${employer.name}:`, error);
        setScanError(`Failed to scan ${employer.name}: ${errMsg}`);
        break;
      }
    }

    setCooldownCountdown(null);
    setIsScanning(false);
    setScanProgress({ current: 0, total: 0, employer: '' });
  };

  const stopScan = () => {
    abortControllerRef.current = true;
    setCooldownCountdown(null);
    setIsScanning(false);
  };

  const formatTimeAgo = (date: any) => {
    if (!date) return 'Never';
    const millis = date.toMillis ? date.toMillis() : (date.getTime ? date.getTime() : 0);
    if (!millis) return 'Never';
    const seconds = Math.floor((Date.now() - millis) / 1000);
    
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const filteredJobs = useMemo(() => {
    let cutoff = 0;
    if (selectedTimeframe === '7d') cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    else if (selectedTimeframe === '14d') cutoff = Date.now() - (14 * 24 * 60 * 60 * 1000);
    else if (selectedTimeframe === '30d') cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);

    let result = jobs.filter(job => {
      // Timeframe cutoff enforcement if not 'all'
      if (cutoff > 0) {
        const foundTime = job.foundDate?.toMillis?.() || job.foundDate?.getTime?.() || 0;
        if (foundTime && foundTime < cutoff) return false;
      }

      const matchesSearch = job.title.toLowerCase().includes(searchTerm.toLowerCase()) || 
                           job.employerName.toLowerCase().includes(searchTerm.toLowerCase());
      const employer = employers.find(e => e.id === job.employerId);
      const matchesCategory = selectedCategory === 'All' || (employer && employer.category === selectedCategory);
      const matchesRoleType = selectedRoleType === 'All' || job.roleType === selectedRoleType;
      const matchesCity = selectedCity === 'All' || job.city === selectedCity;
      
      return matchesSearch && matchesCategory && matchesRoleType && matchesCity;
    });

    return result.sort((a, b) => {
      const timeA = a.foundDate?.toMillis?.() || a.foundDate?.getTime?.() || 0;
      const timeB = b.foundDate?.toMillis?.() || b.foundDate?.getTime?.() || 0;

      if (sortBy === 'newest') return timeB - timeA;
      if (sortBy === 'oldest') return timeA - timeB;
      if (sortBy === 'employer') return (a.employerName || '').localeCompare(b.employerName || '');
      if (sortBy === 'title') return (a.title || '').localeCompare(b.title || '');
      return 0;
    });
  }, [jobs, searchTerm, selectedCategory, selectedRoleType, selectedCity, selectedTimeframe, sortBy, employers]);

  const categories: string[] = ['All', ...Array.from(new Set<string>(employers.map(e => e.category).filter((c): c is string => Boolean(c))))];
  const roleTypes: string[] = ['All', ...Array.from(new Set<string>(jobs.map(j => j.roleType).filter((r): r is string => Boolean(r))))];
  const cities: string[] = ['All', ...Array.from(new Set<string>(jobs.map(j => j.city).filter((c): c is string => Boolean(c))))];

  const exportToCSV = () => {
    const headers = ['Employer', 'Category', 'Job Title', 'Role Type', 'City', 'Location', 'URL', 'Found Date'];
    const rows = filteredJobs.map(job => {
      const employer = employers.find(e => e.id === job.employerId);
      return [
        `"${job.employerName}"`,
        `"${employer?.category || 'N/A'}"`,
        `"${job.title}"`,
        `"${job.roleType || 'N/A'}"`,
        `"${job.city || 'N/A'}"`,
        `"${job.location || 'N/A'}"`,
        `"${job.url}"`,
        `"${job.foundDate?.toDate ? job.foundDate.toDate().toLocaleString() : 'N/A'}"`
      ];
    });

    const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `welcoming_center_jobs_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="w-12 h-12 text-blue-600 animate-spin" />
          <p className="text-slate-600 font-medium">Loading The Welcoming Center Job Board...</p>
        </div>
      </div>
    );
  }

  if (fatalError) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center border border-red-100">
          <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8 text-red-600" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Connection Error</h2>
          <p className="text-slate-600 mb-6 text-sm">
            {fatalError}
          </p>
          <button 
            onClick={() => window.location.reload()}
            className="w-full py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 transition-all"
          >
            Retry Connection
          </button>
          <p className="mt-4 text-xs text-slate-400">
            If this persists, please check your network connection or Firestore database status.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-20">
            <div className="flex items-center gap-3.5" id="app-logo">
              <div className="w-11 h-11 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-200" id="logo-icon">
                <Briefcase className="w-6 h-6 text-white" />
              </div>
              <div id="logo-text">
                <h1 className="text-xl font-bold text-slate-900 leading-tight">The Welcoming Center Job Board</h1>
                <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Philadelphia Partner Network</p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 bg-emerald-50 border border-emerald-200 rounded-full text-xs font-semibold text-emerald-700">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span>Live Synced Directory</span>
              </div>

              <nav className="flex items-center bg-slate-100 p-1 rounded-xl">
                <button
                  id="tab-jobs"
                  onClick={() => setActiveTab('jobs')}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-all cursor-pointer ${
                    activeTab === 'jobs' 
                      ? 'bg-white text-blue-600 shadow-sm' 
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Jobs
                </button>
                <button
                  id="tab-employers"
                  onClick={() => setActiveTab('employers')}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-all cursor-pointer ${
                    activeTab === 'employers' 
                      ? 'bg-white text-blue-600 shadow-sm' 
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Employers
                </button>
              </nav>

              {/* Admin Lock Status */}
              <div className="flex items-center">
                {isAdminUnlocked ? (
                  <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-xl">
                    <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-700">
                      <Unlock className="w-3.5 h-3.5 text-emerald-600" />
                      Admin Unlocked
                    </span>
                    <button
                      onClick={handleLockAdmin}
                      title="Lock administrative editing"
                      className="ml-1 text-[11px] font-semibold text-slate-500 hover:text-red-600 hover:underline px-1 py-0.5 rounded transition-colors"
                    >
                      Lock
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setPasswordInput('');
                      setPasswordError(null);
                      setShowPasswordModal(true);
                    }}
                    title="Click to unlock admin editing mode"
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-semibold rounded-xl transition-all cursor-pointer border border-slate-200"
                  >
                    <Lock className="w-3.5 h-3.5 text-slate-500" />
                    <span>Admin Lock</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex-1 w-full">
        {/* Dashboard Stats (Removed Coached Placements as requested) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-5">
            <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center">
              <Building2 className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-slate-500 font-medium">Partner Employers</p>
              <p className="text-2xl font-bold text-slate-900">{employers.length}</p>
            </div>
          </div>
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-5">
            <div className="w-12 h-12 bg-emerald-50 rounded-xl flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-emerald-600" />
            </div>
            <div>
              <p className="text-sm text-slate-500 font-medium">Active Postings</p>
              <p className="text-2xl font-bold text-slate-900">{jobs.length}</p>
            </div>
          </div>
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-5">
            <div className="w-12 h-12 bg-purple-50 rounded-xl flex items-center justify-center">
              <Clock className="w-6 h-6 text-purple-600" />
            </div>
            <div>
              <p className="text-sm text-slate-500 font-medium">Last Global Scan</p>
              <p className="text-lg font-bold text-slate-900">
                {employers.some(e => e.lastScanned) 
                  ? new Date(Math.max(...employers.map(e => e.lastScanned?.toMillis ? e.lastScanned.toMillis() : (e.lastScanned?.getTime ? e.lastScanned.getTime() : 0)))).toLocaleDateString()
                  : 'Never'}
              </p>
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 mb-8">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col lg:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search jobs or employers..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-12 pr-4 py-3 bg-slate-50 border-none rounded-xl focus:ring-2 focus:ring-blue-500 transition-all text-slate-900"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={exportToCSV}
                  className="flex items-center gap-2 px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl transition-all cursor-pointer text-sm"
                >
                  <Download className="w-4 h-4" />
                  Export CSV
                </button>

                {selectedCategory !== 'All' && (
                  <button
                    onClick={() => scanAll('category', selectedCategory)}
                    disabled={isScanning}
                    title={`Scan only employers in ${selectedCategory} (fast & quota-safe)`}
                    className={`flex items-center gap-2 px-4 py-3 font-semibold rounded-xl transition-all shadow-md text-sm cursor-pointer ${
                      isScanning 
                        ? 'bg-slate-200 text-slate-400 cursor-not-allowed' 
                        : 'bg-amber-500 hover:bg-amber-600 text-white shadow-amber-200'
                    }`}
                  >
                    <Zap className={`w-4 h-4 ${isScanning ? 'animate-bounce' : ''}`} />
                    <span>Scan {selectedCategory} ({employers.filter(e => e.category === selectedCategory).length})</span>
                  </button>
                )}

                <button
                  onClick={() => scanAll('unscanned')}
                  disabled={isScanning}
                  title="Scan partners not scanned in the last 24 hours (fastest & free-tier friendly)"
                  className={`flex items-center gap-2 px-4 py-3 font-semibold rounded-xl transition-all shadow-md text-sm cursor-pointer ${
                    isScanning 
                      ? 'bg-slate-200 text-slate-400 cursor-not-allowed' 
                      : 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-200'
                  }`}
                >
                  <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
                  {isScanning ? 'Scanning...' : 'Scan Outdated'}
                </button>
                <button
                  onClick={() => scanAll('all')}
                  disabled={isScanning}
                  title="Force re-scan of all 44 employer partners with safe free-tier rate-pacing"
                  className={`flex items-center gap-2 px-4 py-3 font-semibold rounded-xl transition-all border text-sm cursor-pointer ${
                    isScanning 
                      ? 'border-slate-200 text-slate-300 cursor-not-allowed bg-slate-50' 
                      : 'border-slate-200 hover:bg-slate-50 text-slate-700 bg-white'
                  }`}
                >
                  Scan All ({employers.length})
                </button>
              </div>
            </div>

            {scanError && (
              <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-xl flex items-center gap-3 text-red-700 text-xs shadow-sm">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <div className="flex-1">
                  <span className="font-bold uppercase tracking-wider block mb-0.5">Scan Notice</span>
                  {scanError}
                </div>
                <button onClick={() => setScanError(null)} className="p-1 hover:bg-red-100 rounded">
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Quick Category Scan Bar */}
            <div className="pt-2 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center gap-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                <Zap className="w-3.5 h-3.5 text-amber-500" />
                <span>Fast Category Scans:</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {categories.filter(c => c !== 'All').map(cat => {
                  const count = employers.filter(e => e.category === cat).length;
                  return (
                    <button
                      key={cat}
                      onClick={() => scanAll('category', cat)}
                      disabled={isScanning}
                      title={`Quick scan ${cat} (${count} partners) - ~${Math.max(count * 6, 10)} seconds`}
                      className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 hover:bg-amber-50 hover:text-amber-700 hover:border-amber-300 text-slate-700 text-xs font-medium rounded-lg border border-slate-200/70 transition-all cursor-pointer disabled:opacity-50"
                    >
                      <span>{cat}</span>
                      <span className="text-[10px] bg-white text-slate-500 px-1 rounded border border-slate-200 font-mono">
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-50">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-wider mr-2">
                <Filter className="w-3 h-3" />
                Filters:
              </div>
              
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="px-4 py-2 bg-slate-50 border-none rounded-lg focus:ring-2 focus:ring-blue-500 transition-all text-sm text-slate-700 font-medium cursor-pointer"
              >
                <option value="All">All Industries</option>
                {categories.filter(c => c !== 'All').map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>

              <select
                value={selectedRoleType}
                onChange={(e) => setSelectedRoleType(e.target.value)}
                className="px-4 py-2 bg-slate-50 border-none rounded-lg focus:ring-2 focus:ring-blue-500 transition-all text-sm text-slate-700 font-medium cursor-pointer"
              >
                <option value="All">All Role Types</option>
                {roleTypes.filter(r => r !== 'All').map(role => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>

              <select
                value={selectedCity}
                onChange={(e) => setSelectedCity(e.target.value)}
                className="px-4 py-2 bg-slate-50 border-none rounded-lg focus:ring-2 focus:ring-blue-500 transition-all text-sm text-slate-700 font-medium cursor-pointer"
              >
                <option value="All">All Cities</option>
                {cities.filter(c => c !== 'All').map(city => (
                  <option key={city} value={city}>{city}</option>
                ))}
              </select>

              <select
                value={selectedTimeframe}
                onChange={(e) => setSelectedTimeframe(e.target.value as any)}
                className="px-4 py-2 bg-slate-50 border-none rounded-lg focus:ring-2 focus:ring-blue-500 transition-all text-sm text-slate-700 font-medium cursor-pointer"
              >
                <option value="7d">Found in Last 7 Days</option>
                <option value="14d">Found in Last 14 Days</option>
                <option value="30d">Found in Last 30 Days</option>
                <option value="all">All Active Postings</option>
              </select>

              <div className="h-6 w-px bg-slate-200 mx-2 hidden sm:block" />

              <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-wider mr-2">
                Sort By:
              </div>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="px-4 py-2 bg-slate-50 border-none rounded-lg focus:ring-2 focus:ring-blue-500 transition-all text-sm text-slate-700 font-medium cursor-pointer"
              >
                <option value="newest">Newest First</option>
                <option value="oldest">Oldest First</option>
                <option value="employer">Employer A-Z</option>
                <option value="title">Job Title A-Z</option>
              </select>
            </div>
          </div>

          {/* Scan Progress */}
          <AnimatePresence>
            {isScanning && (
              <motion.div 
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="mt-4 pt-4 border-t border-slate-100 overflow-hidden"
              >
                <div className="flex flex-wrap items-center justify-between text-sm font-medium text-slate-600 mb-2 gap-2">
                  <span className="flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin text-blue-600" />
                    {cooldownCountdown !== null ? (
                      <span className="text-amber-600 font-semibold bg-amber-50 px-2 py-0.5 rounded border border-amber-200 animate-pulse">
                        ⏳ Free-Tier Pacing: Resuming in {cooldownCountdown}s...
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        {scanProgress.category && (
                          <span className="text-xs font-bold bg-amber-100 text-amber-800 px-2 py-0.5 rounded flex items-center gap-1">
                            <Zap className="w-3 h-3 text-amber-600" />
                            {scanProgress.category}
                          </span>
                        )}
                        <span>Scanning: <strong className="text-slate-800">{scanProgress.employer}</strong></span>
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-4">
                    {scanError && (
                      <span className="text-amber-600 text-[11px] font-medium bg-amber-50 px-2 py-0.5 rounded border border-amber-200 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        Pacing / Quota Note
                      </span>
                    )}
                    <span className="font-mono text-xs text-slate-500">{scanProgress.current} / {scanProgress.total}</span>
                    <button 
                      onClick={stopScan}
                      className="text-red-500 hover:text-red-700 font-bold text-xs px-2 py-1 bg-red-50 hover:bg-red-100 rounded transition-all cursor-pointer"
                    >
                      Stop Scan
                    </button>
                  </div>
                </div>
                <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                  <motion.div 
                    className="h-full bg-blue-600 transition-all duration-300"
                    initial={{ width: 0 }}
                    animate={{ width: `${(scanProgress.current / scanProgress.total) * 100}%` }}
                  />
                </div>
                <div className="flex items-center justify-between mt-2 text-[11px] text-slate-400">
                  <span>✨ Free-Tier Protected: Safe rate-pacing active</span>
                  <span>Direct job link verification for Greater Philadelphia region</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Content Tabs */}
        {activeTab === 'jobs' ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-lg font-bold text-slate-900">Latest Job Postings</h2>
              <span className="text-sm text-slate-500 font-medium">{filteredJobs.length} results</span>
            </div>
            
            {filteredJobs.length === 0 ? (
              <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center">
                <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Search className="w-8 h-8 text-slate-300" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">No jobs found</h3>
                <p className="text-slate-500 max-w-xs mx-auto mt-1">
                  Try adjusting your search or category filters, or run a new scan.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4">
                {filteredJobs.map((job) => (
                  <motion.div
                    layout
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    key={job.id}
                    className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 hover:border-blue-200 hover:shadow-md transition-all group"
                  >
                    <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-bold text-blue-600 uppercase tracking-wider bg-blue-50 px-2 py-0.5 rounded">
                            {employers.find(e => e.id === job.employerId)?.category || 'General'}
                          </span>
                          {job.roleType && (
                            <span className="text-xs font-bold text-emerald-600 uppercase tracking-wider bg-emerald-50 px-2 py-0.5 rounded">
                              {job.roleType}
                            </span>
                          )}
                          <span className="text-xs text-slate-400 font-medium flex items-center gap-1">
                            <Calendar className="w-3 h-3" />
                            Found {job.foundDate?.toDate ? job.foundDate.toDate().toLocaleDateString() : 'Recently'}
                          </span>
                        </div>
                        <h3 className="text-lg font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                          {job.title}
                        </h3>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
                          <div className="flex items-center gap-1.5 text-sm text-slate-600 font-medium">
                            <Building2 className="w-4 h-4 text-slate-400" />
                            {job.employerName}
                          </div>
                          <div className="flex items-center gap-1.5 text-sm text-slate-600 font-medium">
                            <MapPin className="w-4 h-4 text-slate-400" />
                            <span className={job.location?.toLowerCase().includes('philly') || job.location?.toLowerCase().includes('philadelphia') ? 'text-blue-700 font-bold' : ''}>
                              {job.location || 'Philadelphia, PA'}
                            </span>
                          </div>
                        </div>
                        {job.description && (
                          <p className="text-sm text-slate-500 mt-3 line-clamp-2 leading-relaxed">
                            {job.description}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col sm:flex-row md:flex-col lg:flex-row items-stretch sm:items-center md:items-stretch lg:items-center gap-2 self-stretch md:self-start">
                        <a
                          href={job.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl transition-all shadow-sm shadow-blue-200 whitespace-nowrap"
                          title="Open direct job posting"
                        >
                          <span>View Posting</span>
                          <ExternalLink className="w-4 h-4" />
                        </a>
                        <a
                          href={`https://www.google.com/search?q=${encodeURIComponent(job.employerName + ' ' + job.title + ' jobs philadelphia')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-center gap-1.5 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 font-semibold text-xs rounded-xl transition-all whitespace-nowrap"
                          title="Search for this specific opening if the employer's direct link has moved"
                        >
                          <Compass className="w-3.5 h-3.5 text-slate-500" />
                          <span>Search Role</span>
                        </a>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between px-2">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Employer Partner Directory</h2>
                <p className="text-sm text-slate-500">Contact & referral directory for The Welcoming Center employer network.</p>
              </div>
              <button
                onClick={() => requireAdmin(() => {
                  setEditingEmployer(null);
                  setShowEmployerModal(true);
                })}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-lg transition-all shadow-md shadow-emerald-100 cursor-pointer"
              >
                <UserPlus className="w-4 h-4" />
                Add New Partner
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {employers.map(emp => (
                <div key={emp.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 flex flex-col justify-between overflow-hidden group">
                  <div className="p-5">
                    <div className="flex justify-between items-start">
                      <button
                        onClick={() => scanAll('category', emp.category)}
                        disabled={isScanning}
                        title={`Click to scan all ${emp.category} partner employers`}
                        className="text-[10px] font-bold text-blue-700 uppercase tracking-widest bg-blue-50 hover:bg-amber-100 hover:text-amber-800 px-2 py-0.5 rounded flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        <span>{emp.category}</span>
                        <Zap className="w-2.5 h-2.5 text-amber-500" />
                      </button>
                      <button 
                        onClick={() => requireAdmin(() => {
                          setEditingEmployer(emp);
                          setShowEmployerModal(true);
                        })}
                        title="Edit Employer (Admin password required)"
                        className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors cursor-pointer"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                    </div>
                    <h3 className="text-lg font-bold text-slate-900 mt-2">{emp.name}</h3>
                    
                    <div className="mt-4 space-y-2">
                      {emp.contactPerson && (
                        <div className="flex items-center gap-2 text-sm text-slate-600">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                          <span className="font-semibold">{emp.contactPerson}</span>
                        </div>
                      )}
                      {(emp.contactEmail || emp.contactPhone) && (
                        <div className="flex flex-col gap-1.5 pl-5">
                          {emp.contactEmail && (
                            <a href={`mailto:${emp.contactEmail}`} className="flex items-center gap-2 text-xs text-blue-600 hover:underline">
                              <Mail className="w-3.5 h-3.5" />
                              {emp.contactEmail}
                            </a>
                          )}
                          {emp.contactPhone && (
                            <div className="flex items-center gap-2 text-xs text-slate-500">
                              <Phone className="w-3.5 h-3.5" />
                              {emp.contactPhone}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {emp.specialistNotes && (
                      <div className="mt-4 p-3 bg-amber-50 rounded-xl border border-amber-100 border-dashed">
                        <div className="flex items-center gap-1.5 text-[10px] font-bold text-amber-700 uppercase mb-1">
                          <Info className="w-3 h-3" />
                          Staff Notes
                        </div>
                        <p className="text-xs text-amber-800 line-clamp-3">
                          {emp.specialistNotes}
                        </p>
                      </div>
                    )}

                    <div className="flex items-center gap-2 mt-4 text-[10px] text-slate-400 font-medium">
                      <Clock className="w-3 h-3" />
                      Last scanned: {formatTimeAgo(emp.lastScanned)}
                    </div>
                  </div>
                  
                  <div className="flex border-t border-slate-50 p-2 gap-2 bg-slate-50/50">
                    <button
                      onClick={() => scanEmployer(emp)}
                      disabled={isScanning}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-white hover:bg-blue-50 text-slate-700 hover:text-blue-600 font-bold text-xs rounded-lg transition-all border border-slate-100 disabled:opacity-50 cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
                      Refresh Jobs
                    </button>
                    {emp.website && (
                      <a
                        href={emp.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 bg-white text-slate-400 hover:text-slate-600 rounded-lg transition-all border border-slate-100"
                        title="Visit career website"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Admin Actions */}
        <div className="mt-12 pt-8 border-t border-slate-200">
          <div className="flex items-center justify-between bg-slate-100 p-6 rounded-2xl">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Admin Actions</h3>
                <span className="text-[10px] font-bold text-slate-500 bg-slate-200 px-2 py-0.5 rounded">Password Protected</span>
              </div>
              <p className="text-xs text-slate-500 mt-1">Manage database and clear stale job postings.</p>
            </div>
            <button
              onClick={() => requireAdmin(() => setShowClearConfirm(true))}
              className="flex items-center gap-2 px-4 py-2 bg-white hover:bg-red-50 text-red-600 font-bold text-sm rounded-xl transition-all shadow-sm border border-slate-200 cursor-pointer"
            >
              <AlertCircle className="w-4 h-4" />
              Clear All Postings
            </button>
          </div>
        </div>

        {/* Password Verification Modal */}
        <AnimatePresence>
          {showPasswordModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 15 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 15 }}
                className="bg-white rounded-3xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-100"
              >
                <div className="bg-slate-900 p-6 flex justify-between items-center text-white">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-blue-500/20 rounded-xl flex items-center justify-center text-blue-400 border border-blue-400/30">
                      <KeyRound className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold">Admin Password</h3>
                      <p className="text-slate-400 text-xs">Required to modify website data</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => {
                      setShowPasswordModal(false);
                      setPendingAdminAction(null);
                    }} 
                    className="p-2 hover:bg-white/10 rounded-full transition-colors cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleVerifyPassword} className="p-6">
                  <p className="text-xs text-slate-600 mb-4">
                    Please enter the administrative password to add or edit employer partners or manage database records.
                  </p>

                  <div className="mb-4">
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                      Password
                    </label>
                    <div className="relative">
                      <input
                        type={showPasswordText ? "text" : "password"}
                        value={passwordInput}
                        onChange={(e) => {
                          setPasswordInput(e.target.value);
                          setPasswordError(null);
                        }}
                        autoFocus
                        required
                        placeholder="Enter password..."
                        className="w-full pl-4 pr-11 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm text-slate-900 font-medium"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPasswordText(!showPasswordText)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 rounded"
                      >
                        {showPasswordText ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    {passwordError && (
                      <p className="text-xs text-red-600 mt-2 font-medium flex items-center gap-1">
                        <AlertCircle className="w-3.5 h-3.5" />
                        {passwordError}
                      </p>
                    )}
                  </div>

                  <div className="flex gap-3 mt-6">
                    <button
                      type="button"
                      onClick={() => {
                        setShowPasswordModal(false);
                        setPendingAdminAction(null);
                      }}
                      className="flex-1 px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-sm transition-all cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-sm transition-all shadow-md shadow-blue-100 cursor-pointer"
                    >
                      Unlock Admin
                    </button>
                  </div>
                </form>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Employer Management Modal */}
        <AnimatePresence>
          {showEmployerModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full overflow-hidden"
              >
                <div className="bg-slate-900 p-6 flex justify-between items-center text-white">
                  <div>
                    <h3 className="text-xl font-bold">{editingEmployer ? 'Edit Employer Partner' : 'Add Employer Partner'}</h3>
                    <p className="text-slate-400 text-xs">The Welcoming Center Directory</p>
                  </div>
                  <button onClick={() => setShowEmployerModal(false)} className="p-2 hover:bg-white/10 rounded-full transition-colors cursor-pointer">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                
                <form onSubmit={handleSaveEmployer} className="p-8">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Employer Name</label>
                        <input name="name" defaultValue={editingEmployer?.name} required className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm" placeholder="e.g. University of Pennsylvania" />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Industry Category</label>
                        <select name="category" defaultValue={editingEmployer?.category} required className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm">
                          {categories.filter(c => c !== 'All').map(cat => <option key={cat} value={cat}>{cat}</option>)}
                          <option value="Health & Human Services">Health & Human Services</option>
                          <option value="Technology">Technology</option>
                          <option value="Hospitality">Hospitality</option>
                          <option value="Non-Profit">Non-Profit</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Careers Website</label>
                        <input name="website" type="url" defaultValue={editingEmployer?.website} className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm" placeholder="https://..." />
                      </div>
                    </div>
                    
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Primary Contact Person</label>
                        <input name="contactPerson" defaultValue={editingEmployer?.contactPerson} className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm" placeholder="e.g. Jane Doe" />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Contact Email</label>
                        <input name="contactEmail" type="email" defaultValue={editingEmployer?.contactEmail} className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm" placeholder="jane.doe@employer.com" />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Contact Phone</label>
                        <input name="contactPhone" type="tel" defaultValue={editingEmployer?.contactPhone} className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm" placeholder="(215) 555-0123" />
                      </div>
                    </div>
                    
                    <div className="md:col-span-2">
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Staff Internal Notes</label>
                      <textarea name="specialistNotes" defaultValue={editingEmployer?.specialistNotes} rows={3} className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm" placeholder="Internal referral process, hiring preferences, common feedback..." />
                    </div>
                  </div>
                  
                  <div className="flex gap-3 mt-8">
                    <button type="button" onClick={() => setShowEmployerModal(false)} className="flex-1 px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-all cursor-pointer">
                      Cancel
                    </button>
                    <button type="submit" className="flex-1 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl transition-all shadow-lg shadow-blue-100 flex items-center justify-center gap-2 cursor-pointer">
                      <Save className="w-5 h-5" />
                      {editingEmployer ? 'Save Changes' : 'Add Partner'}
                    </button>
                  </div>
                </form>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Clear Postings Confirmation Modal */}
        <AnimatePresence>
          {showClearConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 border border-slate-100"
              >
                <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-6">
                  <AlertCircle className="w-8 h-8 text-red-600" />
                </div>
                <h3 className="text-2xl font-bold text-slate-900 text-center mb-2">Clear All Postings?</h3>
                <p className="text-slate-600 text-center mb-8">
                  This will permanently delete all tracked job postings from the database. This action cannot be undone.
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowClearConfirm(false)}
                    className="flex-1 px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-all cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={clearAllJobs}
                    className="flex-1 px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl transition-all shadow-lg shadow-red-200 cursor-pointer"
                  >
                    Yes, Clear All
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-slate-200 py-8 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-3">
              <Briefcase className="w-5 h-5 text-slate-400" />
              <p className="text-slate-500 text-sm font-medium">
                &copy; 2026 The Welcoming Center Job Board. All rights reserved.
              </p>
            </div>
            <div className="flex items-center gap-6">
              <span className="text-xs text-slate-400 font-medium">Philadelphia, PA</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
