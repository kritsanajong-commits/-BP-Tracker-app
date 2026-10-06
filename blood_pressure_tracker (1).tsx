import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, Plus, History, Camera, Save, X, AlertCircle, 
  Heart, ActivitySquare, Calendar, ChevronLeft, Loader2, Info
} from 'lucide-react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer 
} from 'recharts';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, onSnapshot, query } from 'firebase/firestore';

// กำหนดค่าเริ่มต้นให้กับ Firebase ตามสภาพแวดล้อม
const firebaseConfig = typeof __firebase_config !== 'undefined' 
  ? JSON.parse(__firebase_config) 
  : { projectId: 'demo-project' }; // Fallback สำหรับการพรีวิวแบบไม่มี config

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-bp-app';

export default function App() {
  const [user, setUser] = useState(null);
  const [records, setRecords] = useState([]);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [currentView, setCurrentView] = useState('dashboard'); // 'dashboard', 'add'
  const [isUploading, setIsUploading] = useState(false);
  
  // Form State
  const [formData, setFormData] = useState({
    sys: '',
    dia: '',
    pulse: '',
    notes: '',
    date: new Date().toISOString().split('T')[0],
    time: new Date().toTimeString().split(' ')[0].substring(0, 5)
  });
  const [imagePreview, setImagePreview] = useState(null);
  const [aiError, setAiError] = useState('');
  
  const fileInputRef = useRef(null);

  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Auth error:", error);
      }
    };
    
    initAuth();
    
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsLoadingAuth(false);
    });
    
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;

    // RULE 1: Strict paths for private data
    const recordsRef = collection(db, 'artifacts', appId, 'users', user.uid, 'blood_pressure');
    
    // RULE 2: No complex queries. Fetch all and sort in memory
    const q = query(recordsRef);
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      // Sort in memory (newest first)
      const sortedData = data.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(sortedData);
    }, (error) => {
      console.error("Firestore error:", error);
    });

    return () => unsubscribe();
  }, [user]);

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsUploading(true);
    setAiError('');

    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64String = reader.result;
      setImagePreview(base64String);
      
      try {
        await analyzeImageWithGemini(base64String);
      } catch (err) {
        console.error("AI Analysis failed:", err);
        setAiError('ระบบ AI ไม่สามารถอ่านค่าได้ กรุณากรอกข้อมูลด้วยตนเอง');
      } finally {
        setIsUploading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const analyzeImageWithGemini = async (base64Image) => {
    // Extract base64 data without the mime type prefix
    const base64Data = base64Image.split(',')[1];
    const mimeType = base64Image.match(/[^:]\w+\/[\w-+\d.]+(?=;|,)/)[0];

    const prompt = `
      คุณคือผู้เชี่ยวชาญด้านการอ่านหน้าจอเครื่องวัดความดันโลหิต
      กรุณาวิเคราะห์รูปภาพนี้และดึงค่า 3 ค่าต่อไปนี้ออกมา:
      1. SYS (Systolic - ค่าความดันตัวบน)
      2. DIA (Diastolic - ค่าความดันตัวล่าง)
      3. Pulse (ชีพจร / อัตราการเต้นของหัวใจ)
      
      ส่งคืนข้อมูลกลับมาในรูปแบบ JSON เท่านั้น โดยใช้ key: 'sys', 'dia', 'pulse'
      ตัวอย่าง: {"sys": 120, "dia": 80, "pulse": 72}
      หากหาค่าใดไม่พบ ให้ใช้ null สำหรับค่านั้น
    `;

    const payload = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: mimeType, data: base64Data } }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
      }
    };

    const apiKey = ""; // Canvas will inject API key
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error('API Request failed');
    
    const result = await response.json();
    const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (textResponse) {
      const parsedData = JSON.parse(textResponse);
      setFormData(prev => ({
        ...prev,
        sys: parsedData.sys || prev.sys,
        dia: parsedData.dia || prev.dia,
        pulse: parsedData.pulse || prev.pulse,
      }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!user || !formData.sys || !formData.dia) {
      alert("กรุณากรอกข้อมูล SYS และ DIA ให้ครบถ้วน");
      return;
    }

    try {
      const recordsRef = collection(db, 'artifacts', appId, 'users', user.uid, 'blood_pressure');
      
      const newRecord = {
        sys: Number(formData.sys),
        dia: Number(formData.dia),
        pulse: formData.pulse ? Number(formData.pulse) : null,
        notes: formData.notes,
        date: formData.date,
        time: formData.time,
        timestamp: new Date(`${formData.date}T${formData.time}`).getTime()
      };

      await addDoc(recordsRef, newRecord);
      
      // Reset form and go to dashboard
      setFormData({
        sys: '', dia: '', pulse: '', notes: '',
        date: new Date().toISOString().split('T')[0],
        time: new Date().toTimeString().split(' ')[0].substring(0, 5)
      });
      setImagePreview(null);
      setCurrentView('dashboard');
      
    } catch (error) {
      console.error("Error saving record:", error);
      alert("เกิดข้อผิดพลาดในการบันทึกข้อมูล");
    }
  };

  const getStatusColor = (sys, dia) => {
    if (sys >= 140 || dia >= 90) return 'text-red-500 bg-red-50 border-red-200'; // สูง
    if (sys >= 130 || dia >= 85) return 'text-orange-500 bg-orange-50 border-orange-200'; // ค่อนข้างสูง
    if (sys <= 90 || dia <= 60) return 'text-blue-500 bg-blue-50 border-blue-200'; // ต่ำ
    return 'text-green-600 bg-green-50 border-green-200'; // ปกติ
  };

  const getStatusText = (sys, dia) => {
    if (sys >= 140 || dia >= 90) return 'ความดันสูง';
    if (sys >= 130 || dia >= 85) return 'ค่อนข้างสูง';
    if (sys <= 90 || dia <= 60) return 'ความดันต่ำ';
    return 'ปกติ';
  };

  // Prepare data for chart (oldest first for x-axis flow)
  const chartData = [...records].reverse().map(record => ({
    name: `${record.date.substring(5)} ${record.time}`, // MM-DD HH:MM
    sys: record.sys,
    dia: record.dia
  }));

  const renderDashboard = () => (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Stats Summary */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center justify-center">
          <span className="text-sm text-gray-500 mb-1 flex items-center gap-1">
            <ActivitySquare size={16} className="text-blue-500" />
            เฉลี่ย SYS
          </span>
          <span className="text-2xl font-bold text-gray-800">
            {records.length ? Math.round(records.reduce((acc, curr) => acc + curr.sys, 0) / records.length) : '-'}
          </span>
        </div>
        <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center justify-center">
          <span className="text-sm text-gray-500 mb-1 flex items-center gap-1">
            <Activity size={16} className="text-indigo-500" />
            เฉลี่ย DIA
          </span>
          <span className="text-2xl font-bold text-gray-800">
            {records.length ? Math.round(records.reduce((acc, curr) => acc + curr.dia, 0) / records.length) : '-'}
          </span>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100">
        <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <Activity size={20} className="text-indigo-500" />
          แนวโน้มความดันโลหิต
        </h3>
        {records.length > 0 ? (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} tickMargin={10} stroke="#9ca3af" />
                <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10 }} stroke="#9ca3af" />
                <Tooltip 
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: '12px' }} />
                <Line type="monotone" dataKey="sys" name="SYS (ตัวบน)" stroke="#ef4444" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                <Line type="monotone" dataKey="dia" name="DIA (ตัวล่าง)" stroke="#3b82f6" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-48 flex items-center justify-center text-gray-400 bg-gray-50 rounded-xl">
            ยังไม่มีข้อมูลประวัติ
          </div>
        )}
      </div>

      {/* History List */}
      <div>
        <h3 className="text-lg font-semibold text-gray-800 mb-3 flex items-center gap-2">
          <History size={20} className="text-indigo-500" />
          ประวัติล่าสุด
        </h3>
        <div className="space-y-3">
          {records.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              <p>ยังไม่มีข้อมูล กดปุ่ม + เพื่อบันทึกข้อมูลใหม่</p>
            </div>
          ) : (
            records.slice(0, 10).map((record) => (
              <div key={record.id} className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-gray-500 flex items-center gap-1">
                    <Calendar size={14} />
                    {record.date} • {record.time}
                  </span>
                  <div className="flex items-end gap-2 mt-1">
                    <span className="text-2xl font-bold text-gray-800">{record.sys}<span className="text-lg text-gray-400 mx-1">/</span>{record.dia}</span>
                    <span className="text-sm text-gray-500 mb-1 flex items-center gap-1">
                      <Heart size={14} className="text-red-400" /> {record.pulse || '-'}
                    </span>
                  </div>
                </div>
                <div className={`px-3 py-1 rounded-full border text-xs font-medium ${getStatusColor(record.sys, record.dia)}`}>
                  {getStatusText(record.sys, record.dia)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );

  const renderAddEntry = () => (
    <div className="animate-in slide-in-from-right-4 duration-300">
      <div className="flex items-center mb-6">
        <button 
          onClick={() => setCurrentView('dashboard')}
          className="p-2 -ml-2 text-gray-500 hover:text-gray-800 bg-transparent rounded-full"
        >
          <ChevronLeft size={24} />
        </button>
        <h2 className="text-xl font-bold text-gray-800 ml-2">บันทึกข้อมูลใหม่</h2>
      </div>

      <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 mb-6">
        <div className="flex items-start gap-3">
          <div className="bg-indigo-100 p-2 rounded-full text-indigo-600 shrink-0">
            <Camera size={20} />
          </div>
          <div>
            <h4 className="font-semibold text-indigo-900 mb-1">อ่านค่าจากรูปภาพอัตโนมัติ</h4>
            <p className="text-sm text-indigo-700 mb-3">
              ใช้ AI (Gemini) ช่วยอ่านค่าจากรูปถ่ายหน้าจอเครื่องวัดความดันของคุณ
            </p>
            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium py-2 px-4 rounded-xl shadow-sm transition-colors flex items-center gap-2"
            >
              {isUploading ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
              {isUploading ? 'กำลังวิเคราะห์...' : 'ถ่ายรูป / เลือกรูปภาพ'}
            </button>
            <input 
              type="file" 
              accept="image/*" 
              capture="environment" 
              ref={fileInputRef}
              onChange={handleImageUpload}
              className="hidden"
            />
          </div>
        </div>

        {aiError && (
          <div className="mt-3 p-3 bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl flex items-start gap-2">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <p>{aiError}</p>
          </div>
        )}

        {imagePreview && (
          <div className="mt-4 relative rounded-xl overflow-hidden border border-indigo-200 h-32 w-full bg-black/5">
            <img src={imagePreview} alt="Preview" className="w-full h-full object-contain" />
            <button 
              onClick={() => setImagePreview(null)}
              className="absolute top-2 right-2 p-1 bg-black/50 text-white rounded-full hover:bg-black/70"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">SYS (ตัวบน)</label>
            <input 
              type="number" 
              required
              value={formData.sys}
              onChange={(e) => setFormData({...formData, sys: e.target.value})}
              className="w-full p-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-lg font-semibold transition-all"
              placeholder="เช่น 120"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">DIA (ตัวล่าง)</label>
            <input 
              type="number" 
              required
              value={formData.dia}
              onChange={(e) => setFormData({...formData, dia: e.target.value})}
              className="w-full p-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-lg font-semibold transition-all"
              placeholder="เช่น 80"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium text-gray-700 flex items-center gap-1">
            ชีพจร (Pulse) <span className="text-gray-400 font-normal text-xs">(เลือกกรอกได้)</span>
          </label>
          <input 
            type="number" 
            value={formData.pulse}
            onChange={(e) => setFormData({...formData, pulse: e.target.value})}
            className="w-full p-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
            placeholder="เช่น 72"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">วันที่</label>
            <input 
              type="date" 
              required
              value={formData.date}
              onChange={(e) => setFormData({...formData, date: e.target.value})}
              className="w-full p-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">เวลา</label>
            <input 
              type="time" 
              required
              value={formData.time}
              onChange={(e) => setFormData({...formData, time: e.target.value})}
              className="w-full p-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all text-sm"
            />
          </div>
        </div>

        <button 
          type="submit"
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 px-4 rounded-xl shadow-lg shadow-indigo-200 mt-6 flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
        >
          <Save size={20} />
          บันทึกข้อมูล
        </button>
      </form>
    </div>
  );

  if (isLoadingAuth) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans pb-24 md:pb-10">
      {/* Header */}
      <header className="bg-white px-4 py-5 shadow-sm sticky top-0 z-10">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-indigo-600 p-2 rounded-xl">
              <Heart className="text-white w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
              BP Tracker
            </h1>
          </div>
          <div className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-lg flex items-center gap-1">
            <Info size={12} /> ข้อมูลส่วนตัว
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-md mx-auto p-4 mt-2">
        {currentView === 'dashboard' ? renderDashboard() : renderAddEntry()}
      </main>

      {/* Floating Action Button (Mobile only when in dashboard) */}
      {currentView === 'dashboard' && (
        <div className="fixed bottom-6 right-6 md:absolute md:bottom-auto md:right-auto md:mt-6 md:static md:flex md:justify-center">
          <button 
            onClick={() => setCurrentView('add')}
            className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-full p-4 shadow-lg shadow-indigo-300 transition-transform active:scale-95 flex items-center justify-center gap-2"
          >
            <Plus size={24} />
            <span className="hidden md:inline font-medium px-2">เพิ่มข้อมูลใหม่</span>
          </button>
        </div>
      )}
    </div>
  );
}