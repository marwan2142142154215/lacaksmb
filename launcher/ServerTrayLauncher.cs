using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal sealed class ServerTrayLauncher : ApplicationContext
{
    private const string StartupKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string StartupName = "SMBFleetServer";
    private readonly string root;
    private readonly string logDirectory;
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem statusItem;
    private readonly ToolStripMenuItem tunnelItem;
    private readonly System.Windows.Forms.Timer monitor;
    private Process nodeProcess;
    private Process tunnelProcess;
    private DateTime nextNodeStart = DateTime.MinValue;
    private DateTime nextTunnelStart = DateTime.MinValue;
    private static readonly object LogLock = new object();
    private const uint EsContinuous = 0x80000000;
    private const uint EsSystemRequired = 0x00000001;

    [DllImport("kernel32.dll")]
    private static extern uint SetThreadExecutionState(uint executionState);

    private ServerTrayLauncher()
    {
        root = FindRoot(AppDomain.CurrentDomain.BaseDirectory);
        logDirectory = Path.Combine(root, ".tools");
        Directory.CreateDirectory(logDirectory);

        statusItem = new ToolStripMenuItem("Memeriksa server…") { Enabled = false };
        tunnelItem = new ToolStripMenuItem("Tunnel belum dikonfigurasi") { Enabled = false };
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add(statusItem);
        menu.Items.Add(tunnelItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Mulai / periksa server", null, delegate { EnsureServer(); EnsureTunnel(); UpdateStatus(); });
        menu.Items.Add("Restart broker (muat ulang .env.local)", null, delegate { RestartBroker(); });
        menu.Items.Add("Buka konfigurasi .env.local", null, delegate { OpenFile(Path.Combine(root, ".env.local")); });
        menu.Items.Add("Buka log server", null, delegate { OpenFile(Path.Combine(logDirectory, "fleet-server.log")); });
        menu.Items.Add("Buka log tunnel", null, delegate { OpenFile(Path.Combine(logDirectory, "cloudflared.log")); });
        menu.Items.Add("Keluar dari launcher (server tetap berjalan)", null, delegate { ExitThread(); });

        tray = new NotifyIcon { Icon = SystemIcons.Shield, Text = "SMB Fleet Server", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { OpenFile(Path.Combine(logDirectory, "fleet-server.log")); };
        RegisterStartup();
        SetThreadExecutionState(EsContinuous | EsSystemRequired);

        EnsureServer();
        EnsureTunnel();
        monitor = new System.Windows.Forms.Timer { Interval = 5000 };
        monitor.Tick += delegate { SetThreadExecutionState(EsContinuous | EsSystemRequired); EnsureServer(); EnsureTunnel(); UpdateStatus(); };
        monitor.Start();
        UpdateStatus();
        tray.BalloonTipTitle = "SMB Fleet Server";
        tray.BalloonTipText = "Launcher aktif. Server dimulai di latar dan akan diperiksa otomatis.";
        tray.ShowBalloonTip(3500);
    }

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new ServerTrayLauncher());
    }

    private static string FindRoot(string baseDirectory)
    {
        DirectoryInfo current = new DirectoryInfo(baseDirectory);
        for (int i = 0; current != null && i < 4; i++, current = current.Parent)
        {
            if (File.Exists(Path.Combine(current.FullName, "server", "index.mjs"))
                && File.Exists(Path.Combine(current.FullName, "package.json"))) return current.FullName;
        }
        throw new InvalidOperationException("Pindahkan SMB-Fleet-Server.exe ke folder artifacts di dalam folder proyek fleet-tracking-server.");
    }

    private void RegisterStartup()
    {
        try
        {
            string executable = Process.GetCurrentProcess().MainModule.FileName;
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(StartupKey, true))
            {
                if (key != null) key.SetValue(StartupName, "\"" + executable + "\"");
            }
        }
        catch (Exception error) { AppendLog("fleet-launcher.log", "Startup registration failed: " + error.Message); }
    }

    private void EnsureServer()
    {
        if (nodeProcess != null)
        {
            try { if (!nodeProcess.HasExited) return; }
            catch { }
            nodeProcess = null;
            nextNodeStart = DateTime.UtcNow.AddSeconds(4);
        }

        if (ProbeHealth())
        {
            return;
        }
        if (DateTime.UtcNow < nextNodeStart) return;

        string script = Path.Combine(root, "server", "index.mjs");
        string node = FindNode();
        if (!File.Exists(Path.Combine(root, ".env.local")))
        {
            AppendLog("fleet-launcher.log", "Server not started: .env.local is missing.");
            nextNodeStart = DateTime.UtcNow.AddSeconds(20);
            return;
        }
        if (String.IsNullOrEmpty(node) || !File.Exists(script))
        {
            AppendLog("fleet-launcher.log", "Server not started: Node.js or server/index.mjs is missing.");
            nextNodeStart = DateTime.UtcNow.AddSeconds(20);
            return;
        }

        try
        {
            ProcessStartInfo start = new ProcessStartInfo(node, "\"" + script + "\"");
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            Process child = new Process { StartInfo = start, EnableRaisingEvents = true };
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) AppendLog("fleet-server.log", args.Data); };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) AppendLog("fleet-server-error.log", args.Data); };
            child.Exited += delegate { AppendLog("fleet-launcher.log", "Broker process exited with code " + SafeExitCode(child) + "."); };
            if (!child.Start()) throw new InvalidOperationException("node.exe failed to start.");
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            nodeProcess = child;
            File.WriteAllText(Path.Combine(logDirectory, "fleet-server.pid"), child.Id.ToString());
            nextNodeStart = DateTime.UtcNow.AddSeconds(10);
            AppendLog("fleet-launcher.log", "Started broker process PID " + child.Id + ".");
        }
        catch (Exception error)
        {
            AppendLog("fleet-launcher.log", "Broker start failed: " + error.Message);
            nextNodeStart = DateTime.UtcNow.AddSeconds(20);
        }
    }

    private void RestartBroker()
    {
        try
        {
            if (nodeProcess != null && !nodeProcess.HasExited)
            {
                nodeProcess.Kill();
                nodeProcess.WaitForExit(3000);
                nodeProcess.Dispose();
            }
        }
        catch (Exception error) { AppendLog("fleet-launcher.log", "Broker restart requested: " + error.Message); }
        nodeProcess = null;
        nextNodeStart = DateTime.MinValue;
        EnsureServer();
        UpdateStatus();
    }

    private void EnsureTunnel()
    {
        if (tunnelProcess != null)
        {
            try { if (!tunnelProcess.HasExited) return; }
            catch { }
            tunnelProcess = null;
            nextTunnelStart = DateTime.UtcNow.AddSeconds(5);
        }

        string cloudflared = Path.Combine(root, ".tools", "cloudflared", "cloudflared.exe");
        string config = Path.Combine(root, ".tools", "cloudflared", "config.yml");
        if (!File.Exists(cloudflared) || !File.Exists(config)) return;
        if (DateTime.UtcNow < nextTunnelStart) return;

        try
        {
            ProcessStartInfo start = new ProcessStartInfo(cloudflared, "tunnel --config \"" + config + "\" run");
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            Process child = new Process { StartInfo = start, EnableRaisingEvents = true };
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) AppendLog("cloudflared.log", args.Data); };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) AppendLog("cloudflared.log", args.Data); };
            child.Exited += delegate { AppendLog("fleet-launcher.log", "Cloudflare Tunnel exited with code " + SafeExitCode(child) + "."); };
            if (!child.Start()) throw new InvalidOperationException("cloudflared.exe failed to start.");
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            tunnelProcess = child;
            nextTunnelStart = DateTime.UtcNow.AddSeconds(10);
            AppendLog("fleet-launcher.log", "Started Cloudflare Tunnel process PID " + child.Id + ".");
        }
        catch (Exception error)
        {
            AppendLog("fleet-launcher.log", "Cloudflare Tunnel start failed: " + error.Message);
            nextTunnelStart = DateTime.UtcNow.AddSeconds(20);
        }
    }

    private bool ProbeHealth()
    {
        string host = ReadConfig("FLEET_BROKER_HOST", "127.0.0.1");
        if (host == "0.0.0.0" || host == "::") host = "127.0.0.1";
        string port = ReadConfig("FLEET_BROKER_PORT", "8787");
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("https://" + host + ":" + port + "/health");
            request.Timeout = 1200;
            request.ReadWriteTimeout = 1200;
            request.ServerCertificateValidationCallback = delegate { return true; };
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) return response.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    private string ReadConfig(string name, string fallback)
    {
        try
        {
            foreach (string line in File.ReadAllLines(Path.Combine(root, ".env.local")))
            {
                string trimmed = line.Trim();
                if (!trimmed.StartsWith(name + "=", StringComparison.Ordinal)) continue;
                return trimmed.Substring(name.Length + 1).Trim().Trim('"', '\'');
            }
        }
        catch { }
        return fallback;
    }

    private string FindNode()
    {
        string fromPath = FindExecutableOnPath("node.exe");
        if (!String.IsNullOrEmpty(fromPath)) return fromPath;
        string[] known = { @"C:\Program Files\nodejs\node.exe", @"C:\Program Files (x86)\nodejs\node.exe" };
        foreach (string candidate in known) if (File.Exists(candidate)) return candidate;
        return null;
    }

    private static string FindExecutableOnPath(string executable)
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string folder in path.Split(Path.PathSeparator))
        {
            string candidate = Path.Combine(folder.Trim('"'), executable);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private void UpdateStatus()
    {
        bool online = ProbeHealth();
        string server = online ? "Broker online" : nodeProcess != null ? "Broker mulai / reconnect" : "Broker offline";
        bool tunnelReady = tunnelProcess != null && !tunnelProcess.HasExited;
        string tunnel = tunnelReady ? "Tunnel berjalan" : File.Exists(Path.Combine(root, ".tools", "cloudflared", "config.yml")) ? "Tunnel menghubungkan" : "Tunnel belum dikonfigurasi";
        statusItem.Text = server;
        tunnelItem.Text = tunnel;
        string tooltip = server + " · " + tunnel;
        tray.Text = tooltip.Length > 63 ? tooltip.Substring(0, 63) : tooltip;
    }

    private void OpenFile(string path)
    {
        try
        {
            if (!File.Exists(path)) File.WriteAllText(path, "");
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
        catch (Exception error) { MessageBox.Show(error.Message, "SMB Fleet Server", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private static int SafeExitCode(Process process) { try { return process.ExitCode; } catch { return -1; } }

    private void AppendLog(string file, string text)
    {
        try
        {
            lock (LogLock) File.AppendAllText(Path.Combine(logDirectory, file), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + text + Environment.NewLine);
        }
        catch { }
    }

    protected override void ExitThreadCore()
    {
        monitor.Stop();
        SetThreadExecutionState(EsContinuous);
        tray.Visible = false;
        tray.Dispose();
        base.ExitThreadCore();
    }
}
