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
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User
} from 'firebase/auth';
import { 
  Search, 
  RefreshCw, 
  ExternalLink, 
  Calendar, 
  Building2, 
  MapPin, 
  Download, 
  Filter,
  LogOut,
  LogIn,
  CheckCircle2,
  AlertCircle,
  Clock,
  Briefcase,
  Mail,
  Phone,
  Info,
  UserPlus,
  Edit2,
  Plus,
  Save,
  X,
  UserCheck
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db, handleFirestoreError, OperationType } from './lib/firebase';
import { INITIAL_EMPLOYERS } from './constants';
import { scanJobsForEmployer, isGeminiConfigured } from './services/jobScanner';

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
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [employers, setEmployers] = useState<Employer[]>([]);
  const [jobs, setJobs] = useState<JobPosting[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedRoleType, setSelectedRoleType] = useState('All');
  const [selectedCity, setSelectedCity] = useState('All');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'employer' | 'title'>('newest');
  const [activeTab, setActiveTab] = useState<'jobs' | 'employers'>('jobs');
  const [isScanning, setIsScanning] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showEmployerModal, setShowEmployerModal] = useState(false);
  const [editingEmployer, setEditingEmployer] = useState<Employer | null>(null);
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0, employer: '' });
  const abortControllerRef = useMemo(() => ({ current: false }), []);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Data Listeners
  useEffect(() => {
    // Public access mode - listeners start immediately
    const qEmployers = query(collection(db, 'employers'), orderBy('name'));
    const unsubscribeEmployers = onSnapshot(qEmployers, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Employer));
      setEmployers(data);
      
      // Seed if empty
      if (data.length === 0) {
        seedEmployers();
      }
    }, (error) => {
      console.error("Firestore Listeners Failed:", error);
      setFatalError(error.message || "Failed to connect to database. Check your internet or configuration.");
    });

    const qJobs = query(collection(db, 'jobPostings'), orderBy('foundDate', 'desc'), limit(200));
    const unsubscribeJobs = onSnapshot(qJobs, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as JobPosting));
      setJobs(data);
    }, (error) => {
      console.error("Jobs Listener Failed:", error);
      // Don't necessarily make it fatal if employers work
    });

    return () => {
      unsubscribeEmployers();
      unsubscribeJobs();
    };
  }, [user]);

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

  const handleLogin = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    setAuthError(null);
    
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      // Handle common Firebase Auth errors gracefully
      if (error.code === 'auth/cancelled-popup-request') {
        console.warn("Login popup was already open or cancelled by a new request.");
      } else if (error.code === 'auth/popup-closed-by-user') {
        setAuthError("Login window was closed. Please try again.");
      } else if (error.code === 'auth/popup-blocked') {
        setAuthError("Login popup was blocked by your browser. Please enable popups for this site.");
      } else {
        console.error("Login failed:", error);
        setAuthError("An unexpected error occurred during login. Please try again.");
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSaveEmployer = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
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

  const scanAll = async () => {
    if (isScanning) return;
    setIsScanning(true);
    setScanError(null);
    abortControllerRef.current = false;
    setScanProgress({ current: 0, total: employers.length, employer: '' });

    let scanFailed = false;

    for (let i = 0; i < employers.length; i++) {
      if (abortControllerRef.current) break;
      
      const employer = employers[i];
      setScanProgress({ current: i + 1, total: employers.length, employer: employer.name });
      
      try {
        const foundJobs = await scanJobsForEmployer(employer.name, employer.website || '');
        
        for (const job of foundJobs) {
          if (abortControllerRef.current) break;

          // Improved duplicate check: URL or (Title + Employer)
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
          }
        }

        await setDoc(doc(db, 'employers', employer.id), {
          lastScanned: serverTimestamp()
        }, { merge: true });

      } catch (error: any) {
        console.error(`Error scanning ${employer.name}:`, error);
        setScanError(`Scan failed for ${employer.name}. This is usually due to an invalid or missing Gemini API Key.`);
        scanFailed = true;
      }
    }

    if (!scanFailed) {
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
        }
      }

      await setDoc(doc(db, 'employers', employer.id), {
        lastScanned: serverTimestamp()
      }, { merge: true });

    } catch (error: any) {
      console.error(`Error scanning ${employer.name}:`, error);
      setScanError(`Failed to scan ${employer.name}. Check API key configuration.`);
    }

    setIsScanning(false);
    setScanProgress({ current: 0, total: 0, employer: '' });
  };

  const stopScan = () => {
    abortControllerRef.current = true;
    setIsScanning(false);
  };

  const formatTimeAgo = (date: any) => {
    if (!date) return 'Never';
    const millis = date.toMillis ? date.toMillis() : date.getTime();
    const seconds = Math.floor((Date.now() - millis) / 1000);
    
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const filteredJobs = useMemo(() => {
    const fifteenDaysAgo = Date.now() - (15 * 24 * 60 * 60 * 1000);

    let result = jobs.filter(job => {
      // 15-day snapshot enforcement
      const foundTime = job.foundDate?.toMillis() || 0;
      if (foundTime < fifteenDaysAgo) return false;

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
  }, [jobs, searchTerm, selectedCategory, selectedRoleType, selectedCity, sortBy, employers]);

  const categories = ['All', ...Array.from(new Set(employers.map(e => e.category)))];
  const roleTypes = ['All', ...Array.from(new Set(jobs.map(j => j.roleType).filter(Boolean)))];
  const cities = ['All', ...Array.from(new Set(jobs.map(j => j.city).filter(Boolean)))];

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
    link.setAttribute("download", `job_trackings_${new Date().toISOString().split('T')[0]}.csv`);
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
          <p className="text-slate-600 font-medium">Loading Philly Job Tracker...</p>
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
            If this persists, please check if Firestore rules are deployed and your configuration is correct.
          </p>
        </div>
      </div>
    );
  }

  // Remove login gate - the app is now public

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-20">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-200">
                <Briefcase className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-slate-900 leading-tight">Philly Job Tracker</h1>
                <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Workforce Development</p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <nav className="hidden md:flex items-center bg-slate-100 p-1 rounded-xl mr-4">
                <button
                  onClick={() => setActiveTab('jobs')}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${
                    activeTab === 'jobs' 
                      ? 'bg-white text-blue-600 shadow-sm' 
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Jobs
                </button>
                <button
                  onClick={() => setActiveTab('employers')}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${
                    activeTab === 'employers' 
                      ? 'bg-white text-blue-600 shadow-sm' 
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Employers
                </button>
              </nav>

              <div className="hidden md:flex items-center gap-3 mr-4">
                {user ? (
                  <>
                    <img 
                      src={user.photoURL || ''} 
                      alt={user.displayName || ''} 
                      className="w-8 h-8 rounded-full border border-slate-200"
                    />
                    <span className="text-sm font-medium text-slate-700">{user.displayName}</span>
                    <button
                      onClick={() => signOut(auth)}
                      className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      title="Logout"
                    >
                      <LogOut className="w-5 h-5" />
                    </button>
                  </>
                ) : (
                  <button
                    onClick={handleLogin}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-blue-600 text-slate-600 hover:text-white font-bold text-sm rounded-lg transition-all"
                  >
                    <LogIn className="w-4 h-4" />
                    Staff Login
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Dashboard Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
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
            <div className="w-12 h-12 bg-green-50 rounded-xl flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-slate-500 font-medium">Active Postings</p>
              <p className="text-2xl font-bold text-slate-900">{jobs.length}</p>
            </div>
          </div>
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-5">
            <div className="w-12 h-12 bg-emerald-50 rounded-xl flex items-center justify-center">
              <UserCheck className="w-6 h-6 text-emerald-600" />
            </div>
            <div>
              <p className="text-sm text-slate-500 font-medium">Coached Placements</p>
              <p className="text-2xl font-bold text-slate-900">12</p>
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
                  ? new Date(Math.max(...employers.map(e => e.lastScanned?.toMillis() || 0))).toLocaleDateString()
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
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={exportToCSV}
                  className="flex items-center gap-2 px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl transition-all"
                >
                  <Download className="w-4 h-4" />
                  Export CSV
                </button>
                <button
                  onClick={scanAll}
                  disabled={isScanning}
                  className={`flex items-center gap-2 px-6 py-3 font-semibold rounded-xl transition-all shadow-lg ${
                    isScanning 
                      ? 'bg-slate-200 text-slate-400 cursor-not-allowed' 
                      : 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-200'
                  }`}
                >
                  <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
                  {isScanning ? 'Scanning...' : 'Scan Now'}
                </button>
              </div>
            </div>

            {!isGeminiConfigured() && (
              <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-3 text-amber-700 text-xs shadow-sm">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <div className="flex-1">
                  <span className="font-bold uppercase tracking-wider block mb-0.5">Configuration Required</span>
                  AI Scanning requires a Google Gemini API Key. Since you are running this from GitHub, you must set the 
                  <code className="mx-1 px-1 bg-white rounded border border-amber-200 font-mono">VITE_GEMINI_API_KEY</code> 
                  environment variable in your build settings (e.g. Vercel, Netlify, or GitHub Actions).
                </div>
              </div>
            )}

            {scanError && (
              <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-xl flex items-center gap-3 text-red-700 text-xs shadow-sm">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <div className="flex-1">
                  <span className="font-bold uppercase tracking-wider block mb-0.5">Scan Error</span>
                  {scanError}
                </div>
                <button onClick={() => setScanError(null)} className="p-1 hover:bg-red-100 rounded">
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

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
                <div className="flex justify-between text-sm font-medium text-slate-600 mb-2">
                  <span className="flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin text-blue-600" />
                    Scanning: {scanProgress.employer}
                  </span>
                  <div className="flex items-center gap-4">
                    {scanError && (
                      <span className="text-red-500 text-[10px] font-bold bg-red-50 px-2 py-0.5 rounded border border-red-100 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        API Error Detected
                      </span>
                    )}
                    <span>{scanProgress.current} / {scanProgress.total}</span>
                    <button 
                      onClick={stopScan}
                      className="text-red-500 hover:text-red-700 font-bold"
                    >
                      Stop
                    </button>
                  </div>
                </div>
                <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                  <motion.div 
                    className="h-full bg-blue-600"
                    initial={{ width: 0 }}
                    animate={{ width: `${(scanProgress.current / scanProgress.total) * 100}%` }}
                  />
                </div>
                <p className="text-[10px] text-slate-400 mt-2 italic">
                  Note: AI is verifying links and filtering for Greater Philadelphia region (including surrounding counties).
                </p>
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
                      <div className="flex items-center gap-3 self-end md:self-start">
                        <a
                          href={job.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 px-4 py-2 bg-blue-50 hover:bg-blue-600 text-blue-600 hover:text-white font-bold text-sm rounded-lg transition-all whitespace-nowrap"
                        >
                          View Job
                          <ExternalLink className="w-4 h-4" />
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
                <h2 className="text-lg font-bold text-slate-900">Specialist Employer Directory</h2>
                <p className="text-sm text-slate-500">Collaborative contact database for Philly workforce partners.</p>
              </div>
              <button
                onClick={() => {
                  setEditingEmployer(null);
                  setShowEmployerModal(true);
                }}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-lg transition-all shadow-md shadow-emerald-100"
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
                      <span className="text-[10px] font-bold text-blue-600 uppercase tracking-widest bg-blue-50 px-2 py-0.5 rounded">{emp.category}</span>
                      <button 
                        onClick={() => {
                          setEditingEmployer(emp);
                          setShowEmployerModal(true);
                        }}
                        className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
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
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-white hover:bg-blue-50 text-slate-700 hover:text-blue-600 font-bold text-xs rounded-lg transition-all border border-slate-100 disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
                      Refresh Jobs
                    </button>
                    <a
                      href={emp.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 bg-white text-slate-400 hover:text-slate-600 rounded-lg transition-all border border-slate-100"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
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
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Admin Actions</h3>
              <p className="text-xs text-slate-500 mt-1">Manage database and stale job postings.</p>
            </div>
            <button
              onClick={() => setShowClearConfirm(true)}
              className="flex items-center gap-2 px-4 py-2 bg-white hover:bg-red-50 text-red-600 font-bold text-sm rounded-xl transition-all shadow-sm border border-slate-200"
            >
              <AlertCircle className="w-4 h-4" />
              Clear All Postings
            </button>
          </div>
        </div>

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
                    <p className="text-slate-400 text-xs">Philly Workforce Specialist Directory</p>
                  </div>
                  <button onClick={() => setShowEmployerModal(false)} className="p-2 hover:bg-white/10 rounded-full transition-colors">
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
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Specialist Internal Notes</label>
                      <textarea name="specialistNotes" defaultValue={editingEmployer?.specialistNotes} rows={3} className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm" placeholder="Internal referral process, hiring preferences, common feedback..." />
                    </div>
                  </div>
                  
                  <div className="flex gap-3 mt-8">
                    <button type="button" onClick={() => setShowEmployerModal(false)} className="flex-1 px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-all">
                      Cancel
                    </button>
                    <button type="submit" className="flex-1 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl transition-all shadow-lg shadow-blue-100 flex items-center justify-center gap-2">
                      <Save className="w-5 h-5" />
                      {editingEmployer ? 'Save Changes' : 'Add Partner'}
                    </button>
                  </div>
                </form>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
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
                  This will permanently delete all tracked job postings. This action cannot be undone.
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowClearConfirm(false)}
                    className="flex-1 px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={clearAllJobs}
                    className="flex-1 px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl transition-all shadow-lg shadow-red-200"
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
      <footer className="bg-white border-t border-slate-200 py-12 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-3">
              <Briefcase className="w-6 h-6 text-slate-400" />
              <p className="text-slate-500 text-sm font-medium">
                &copy; 2026 Philly Workforce Job Tracker. All rights reserved.
              </p>
            </div>
            <div className="flex items-center gap-8">
              <a href="#" className="text-sm font-medium text-slate-400 hover:text-slate-600 transition-colors">Privacy Policy</a>
              <a href="#" className="text-sm font-medium text-slate-400 hover:text-slate-600 transition-colors">Terms of Service</a>
              <a href="#" className="text-sm font-medium text-slate-400 hover:text-slate-600 transition-colors">Contact Support</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
