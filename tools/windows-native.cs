// Loaded only by the guarded Windows helper. No process is started by compiling this file.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;

public static class CanopyNative {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting { public long UserTime, KernelTime, PeriodUser, PeriodKernel; public uint PageFaults, Total, Active, Terminated; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public uint Size; public string Reserved, Desktop, Title; public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags; public ushort Show,ReservedSize; public IntPtr ReservedBytes,Input,Output,Error; }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Id,ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct Security { public uint Size; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref Limits limits,int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out Accounting account,int size,IntPtr length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,ref Security security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder args,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo info);
    static void Require(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string arg) {
        // CommandLineToArgvW quoting, including trailing backslashes before the closing quote.
        var text = new StringBuilder("\""); int slashes=0;
        foreach (char c in arg) {
            if (c=='\\') { slashes++; continue; }
            text.Append('\\', c=='"' ? slashes*2+1 : slashes); text.Append(c); slashes=0;
        }
        text.Append('\\',slashes*2); return text.Append('"').ToString();
    }
    static bool Empty(IntPtr job) { Accounting a; Require(QueryInformationJobObject(job,1,out a,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)); return a.Active==0; }
    static bool WaitEmpty(IntPtr job,int deadlineMs) {
        var clock=Stopwatch.StartNew(); do { if (Empty(job)) return true; Thread.Sleep(25); } while(clock.ElapsedMilliseconds<deadlineMs); return Empty(job);
    }
    public static Dictionary<string,object> Run(string file,string[] args,int timeoutMs,bool observe) {
        if(timeoutMs<1 || timeoutMs>90000) throw new ArgumentException("Deadline required");
        IntPtr job=IntPtr.Zero, sink=IntPtr.Zero, attributes=IntPtr.Zero, jobPointer=IntPtr.Zero; bool initialized=false; ProcessInfo pi=new ProcessInfo(); bool assigned=false, absent=false;
        string primary=null, secondary=null; uint code=259;
        try {
            job=CreateJobObject(IntPtr.Zero,null); Require(job!=IntPtr.Zero);
            var limits=new Limits(); limits.Basic.Flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway.
            Require(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(Limits))));
            var security=new Security { Size=(uint)Marshal.SizeOf(typeof(Security)), Inherit=true };
            sink=CreateFile("NUL",0xC0000000,3,ref security,3,0,IntPtr.Zero); Require(sink!=new IntPtr(-1));
            IntPtr attributeSize=IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref attributeSize);
            if(attributeSize==IntPtr.Zero) throw new Exception("Job attribute sizing failed");
            attributes=Marshal.AllocHGlobal(attributeSize); Require(InitializeProcThreadAttributeList(attributes,1,0,ref attributeSize)); initialized=true;
            jobPointer=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobPointer,job);
            // PROC_THREAD_ATTRIBUTE_JOB_LIST assigns ownership atomically at creation, including cancellation during CreateProcess.
            Require(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x0002000D),jobPointer,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
            var startup=new StartupEx { Startup=new Startup { Size=(uint)Marshal.SizeOf(typeof(StartupEx)), Flags=0x100, Input=sink, Output=sink, Error=sink }, Attributes=attributes };
            var line=new StringBuilder(Quote(file)); foreach(var arg in args) line.Append(" ").Append(Quote(arg));
            // The main thread is both job-owned and suspended before any user code can execute.
            Require(CreateProcess(file,line,IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,null,ref startup,out pi)); assigned=true;
            Require(ResumeThread(pi.Thread)!=0xffffffff);
            uint wait=WaitForSingleObject(pi.Process,(uint)timeoutMs);
            if(observe) { if(wait!=258) primary="Owned application exited before observation deadline"; }
            else if(wait!=0) primary="Owned native operation timed out or wait failed";
            else { Require(GetExitCodeProcess(pi.Process,out code)); if(code!=0) primary="Owned native operation returned failure"; }
            // A parent exiting does not imply that its installer/application descendants exited.
            if(!observe && primary==null && !WaitEmpty(job,10000)) primary="Owned descendants did not exit";
            if(observe || primary!=null) Require(TerminateJobObject(job,1));
            absent=WaitEmpty(job,10000) && WaitForSingleObject(pi.Process,0)==0;
            if(!absent) secondary="Owned job absence could not be confirmed";
        } catch { primary=primary ?? "Owned process creation, execution or cleanup failed"; }
        finally {
            if(pi.Process!=IntPtr.Zero && !absent) {
                try {
                    // A failed assignment leaves a still-suspended process. Terminate its retained HANDLE, never a PID.
                    Require(assigned ? TerminateJobObject(job,1) : TerminateProcess(pi.Process,1));
                    absent=WaitForSingleObject(pi.Process,10000)==0 && (!assigned || WaitEmpty(job,10000));
                    if(!absent) secondary="Owned termination remained unconfirmed";
                } catch { secondary="Owned termination failed"; }
            }
            if(initialized) DeleteProcThreadAttributeList(attributes);
            if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if(jobPointer!=IntPtr.Zero) Marshal.FreeHGlobal(jobPointer);
            if(pi.Thread!=IntPtr.Zero) CloseHandle(pi.Thread);
            if(pi.Process!=IntPtr.Zero) CloseHandle(pi.Process);
            if(sink!=IntPtr.Zero && sink!=new IntPtr(-1)) CloseHandle(sink);
            if(job!=IntPtr.Zero) CloseHandle(job); // Last-resort kill-on-close; uncertainty stays a failure.
        }
        return new Dictionary<string,object> { {"ok",primary==null && secondary==null && absent}, {"error",primary}, {"cleanupError",secondary}, {"ownedAbsent",absent}, {"exitCode",code} };
    }
    [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id,uint flags,IntPtr token,out IntPtr path);
    public static string KnownFolder(string id) { Guid guid=new Guid(id); IntPtr p=IntPtr.Zero; try { if(SHGetKnownFolderPath(ref guid,0x4000,IntPtr.Zero,out p)!=0) throw new Exception("Known folder unresolved"); return Marshal.PtrToStringUni(p); } finally { if(p!=IntPtr.Zero) Marshal.FreeCoTaskMem(p); } }

    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct FileInfo { public uint Size; public string Path; public IntPtr File,Subject; }
    [StructLayout(LayoutKind.Sequential)] struct TrustData { public uint Size; public IntPtr Policy,Sip; public uint Ui,Revocation,Union; public IntPtr File; public uint Action; public IntPtr State; public IntPtr Url; public uint Flags,Context; public IntPtr Settings; }
    [StructLayout(LayoutKind.Sequential)] struct Signer { public uint Size; public System.Runtime.InteropServices.ComTypes.FILETIME Time; public uint Certs; public IntPtr Chain; public uint Type; public IntPtr Info; public uint Error,Counters; public IntPtr CounterSigners,ChainContext; }
    [StructLayout(LayoutKind.Sequential)] struct ProviderCert { public uint Size; public IntPtr Cert; }
    [DllImport("wintrust.dll",ExactSpelling=true)] static extern int WinVerifyTrust(IntPtr window,ref Guid action,ref TrustData data);
    [DllImport("wintrust.dll")] static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
    [DllImport("wintrust.dll")] static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr data,uint signer,bool counter,uint counterIndex);
    [DllImport("wintrust.dll")] static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer,uint index);
    public static Dictionary<string,object> Trust(string path) {
        var file=new FileInfo { Size=(uint)Marshal.SizeOf(typeof(FileInfo)), Path=path };
        IntPtr pointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo))); Marshal.StructureToPtr(file,pointer,false);
        var data=new TrustData { Size=(uint)Marshal.SizeOf(typeof(TrustData)), Ui=2, Revocation=1, Union=1, File=pointer, Action=1, Flags=0x2080 };
        Guid action=new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        try {
            if(WinVerifyTrust(new IntPtr(-1),ref action,ref data)!=0) throw new Exception("Native Authenticode trust/revocation rejected");
            IntPtr signerPtr=WTHelperGetProvSignerFromChain(WTHelperProvDataFromStateData(data.State),0,false,0);
            if(signerPtr==IntPtr.Zero) throw new Exception("Missing native signer");
            var signer=Marshal.PtrToStructure<Signer>(signerPtr);
            IntPtr tsaPtr=WTHelperGetProvSignerFromChain(WTHelperProvDataFromStateData(data.State),0,true,0);
            if(tsaPtr==IntPtr.Zero) throw new Exception("Missing native timestamp chain");
            var tsa=Marshal.PtrToStructure<Signer>(tsaPtr);
            if(tsa.Error!=0 || tsa.Certs<2) throw new Exception("Native timestamp chain rejected");
            var tsaLeaf=Marshal.PtrToStructure<ProviderCert>(WTHelperGetProvCertFromChain(tsaPtr,0));
            var tsaLast=Marshal.PtrToStructure<ProviderCert>(WTHelperGetProvCertFromChain(tsaPtr,tsa.Certs-1));
            if(signer.Error!=0 || signer.Certs<2) throw new Exception("Native signer chain rejected");
            var leaf=Marshal.PtrToStructure<ProviderCert>(WTHelperGetProvCertFromChain(signerPtr,0));
            var last=Marshal.PtrToStructure<ProviderCert>(WTHelperGetProvCertFromChain(signerPtr,signer.Certs-1));
            using(var certificate=new X509Certificate2(leaf.Cert)) using(var root=new X509Certificate2(last.Cert))
            using(var timestamp=new X509Certificate2(tsaLeaf.Cert)) using(var timestampRoot=new X509Certificate2(tsaLast.Cert)) {
                var ekus=new List<string>(); foreach(var extension in certificate.Extensions) {
                    var eku=extension as X509EnhancedKeyUsageExtension;
                    if(eku!=null) foreach(var oid in eku.EnhancedKeyUsages) ekus.Add(oid.Value);
                }
                long instant=((long)(uint)signer.Time.dwHighDateTime<<32)|(uint)signer.Time.dwLowDateTime;
                return new Dictionary<string,object> { {"subject",certificate.Subject}, {"thumbprint",certificate.Thumbprint}, {"ekus",ekus},
                    {"rootSha256",Convert.ToHexString(SHA256.HashData(root.RawData))},
                    {"timestampRootSha256",Convert.ToHexString(SHA256.HashData(timestampRoot.RawData))},
                    {"timestampThumbprint",timestamp.Thumbprint},
                    {"timestampNotBefore",timestamp.NotBefore.ToUniversalTime().ToString("o")},
                    {"timestampNotAfter",timestamp.NotAfter.ToUniversalTime().ToString("o")}, {"verifiedAt",DateTime.FromFileTimeUtc(instant).ToString("o")},
                    {"notBefore",certificate.NotBefore.ToUniversalTime().ToString("o")}, {"notAfter",certificate.NotAfter.ToUniversalTime().ToString("o")} };
            }
        } finally { data.Action=2; WinVerifyTrust(new IntPtr(-1),ref action,ref data); Marshal.DestroyStructure<FileInfo>(pointer); Marshal.FreeHGlobal(pointer); }
    }
}
