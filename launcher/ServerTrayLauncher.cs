using System;
using System.Collections.Generic;
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
    private static readonly Color Ink = Color.FromArgb(25, 48, 50);
    private static readonly Color Muted = Color.FromArgb(124, 144, 144);
    private static readonly Color Green = Color.FromArgb(20, 130, 99);
    private static readonly Color GreenDark = Color.FromArgb(13, 91, 71);
    private static readonly Color Canvas = Color.FromArgb(243, 247, 246);
    private readonly string root;
    private readonly string logDirectory;
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem statusItem;
    private readonly ToolStripMenuItem tunnelItem;
    private readonly System.Windows.Forms.Timer monitor;
    private readonly Form window;
    private readonly Label brokerValue;
    private readonly Label tunnelValue;
    private readonly Label rootValue;
    private readonly Label footerValue;
    private readonly RichTextBox logView;
    private readonly List<string> visibleLog = new List<string>();
    private Process nodeProcess;
    private Process tunnelProcess;
    private bool allowClose;
    private DateTime nextNodeStart = DateTime.MinValue;
    private DateTime nextTunnelStart = DateTime.MinValue;
    private DateTime lastExternalTunnelLog = DateTime.MinValue;
    private static readonly object LogLock = new object();
    private const uint EsContinuous = 0x80000000;
    private const uint EsSystemRequired = 0x00000001;

    [DllImport("kernel32.dll")]
    private static extern uint SetThreadExecutionState(uint executionState);

    private ServerTrayLauncher()
    {
        root = FindOrSelectRoot(AppDomain.CurrentDomain.BaseDirectory);
        if (String.IsNullOrEmpty(root)) throw new OperationCanceledException("Folder server belum dipilih.");
        Bootstrap("Preparing server console at " + root);
        logDirectory = Path.Combine(root, ".tools");
        Directory.CreateDirectory(logDirectory);

        Bootstrap("Building control window.");
        window = BuildWindow(out brokerValue, out tunnelValue, out rootValue, out footerValue, out logView);
        Bootstrap("Control window built.");
        statusItem = new ToolStripMenuItem("Memeriksa broker…") { Enabled = false };
        tunnelItem = new ToolStripMenuItem("Memeriksa Tunnel…") { Enabled = false };
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add(statusItem);
        menu.Items.Add(tunnelItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Buka panel SMB Server", null, delegate { ShowWindow(); });
        menu.Items.Add("Restart broker", null, delegate { RestartBroker(); });
        menu.Items.Add("Buka konfigurasi .env.local", null, delegate { OpenFile(Path.Combine(root, ".env.local")); });
        menu.Items.Add("Buka folder log", null, delegate { OpenFile(logDirectory); });
        menu.Items.Add("Keluar dari launcher (server tetap berjalan)", null, delegate { ExitThread(); });
        tray = new NotifyIcon { Icon = SystemIcons.Shield, Text = "SMB Fleet Server", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { ShowWindow(); };

        Bootstrap("Loading saved log files.");
        LoadExistingLogs();
        window.FormClosing += delegate(object sender, FormClosingEventArgs args)
        {
            if (args.CloseReason == CloseReason.UserClosing && !allowClose)
            {
                args.Cancel = true;
                window.Hide();
                tray.ShowBalloonTip(1800, "SMB Server tetap berjalan", "Panel disembunyikan ke system tray.", ToolTipIcon.Info);
            }
        };
        window.Shown += delegate { ShowWindow(); };
        RegisterStartup();
        SetThreadExecutionState(EsContinuous | EsSystemRequired);

        Bootstrap("Checking the broker process.");
        EnsureServer();
        Bootstrap("Checking the Cloudflare Tunnel process.");
        EnsureTunnel();
        monitor = new System.Windows.Forms.Timer { Interval = 3000 };
        monitor.Tick += delegate
        {
            SetThreadExecutionState(EsContinuous | EsSystemRequired);
            EnsureServer();
            EnsureTunnel();
            UpdateStatus();
        };
        monitor.Start();
        UpdateStatus();
        AppendLog("fleet-launcher.log", "Panel SMB Server dibuka untuk " + root + ".");
        Bootstrap("Control window is ready.");
        ShowWindow();
    }

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            Bootstrap("Launcher start: " + AppDomain.CurrentDomain.BaseDirectory);
            Application.Run(new ServerTrayLauncher());
        }
        catch (OperationCanceledException) { Bootstrap("Folder picker dibatalkan."); }
        catch (Exception error) { Bootstrap(error.ToString()); MessageBox.Show(error.Message, "SMB Server Console", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private static void Bootstrap(string line)
    {
        try
        {
            string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SMBFleetServer");
            Directory.CreateDirectory(directory);
            File.AppendAllText(Path.Combine(directory, "startup.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + line + Environment.NewLine);
        }
        catch { }
    }

    private static string FindOrSelectRoot(string baseDirectory)
    {
        string savedRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SMBFleetServer", "root.txt");
        try
        {
            if (File.Exists(savedRoot))
            {
                string saved = File.ReadAllText(savedRoot).Trim();
                if (IsProjectRoot(saved)) return saved;
            }
        }
        catch { }

        DirectoryInfo current = new DirectoryInfo(baseDirectory);
        for (int i = 0; current != null && i < 7; i++, current = current.Parent)
        {
            Bootstrap("Checking server root: " + current.FullName);
            if (IsProjectRoot(current.FullName)) { Bootstrap("Using server root: " + current.FullName); return current.FullName; }
        }

        using (FolderBrowserDialog picker = new FolderBrowserDialog())
        {
            picker.Description = "Pilih folder proyek SMB yang berisi server\\index.mjs dan .env.local.";
            picker.ShowNewFolderButton = false;
            while (picker.ShowDialog() == DialogResult.OK)
            {
                if (IsProjectRoot(picker.SelectedPath))
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(savedRoot));
                    File.WriteAllText(savedRoot, picker.SelectedPath);
                    return picker.SelectedPath;
                }
                MessageBox.Show("Folder ini belum berisi server\\index.mjs. Pilih folder proyek SMB yang benar.", "Folder server tidak valid", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
        return null;
    }

    private static bool IsProjectRoot(string folder)
    {
        return !String.IsNullOrEmpty(folder)
            && File.Exists(Path.Combine(folder, "server", "index.mjs"))
            && File.Exists(Path.Combine(folder, "package.json"));
    }

    private Form BuildWindow(out Label broker, out Label tunnel, out Label rootLabel, out Label footer, out RichTextBox logs)
    {
        Form form = new Form
        {
            Text = "SMB Lacak Bot · Server Console",
            StartPosition = FormStartPosition.CenterScreen,
            MinimumSize = new Size(800, 580),
            Size = new Size(1040, 740),
            BackColor = Canvas,
            Font = new Font("Segoe UI", 9f),
            Icon = SystemIcons.Shield
        };
        TableLayoutPanel layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(22), ColumnCount = 1, RowCount = 5, BackColor = Canvas };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 106));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 104));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        form.Controls.Add(layout);

        Panel header = new Panel { Dock = DockStyle.Fill, BackColor = GreenDark, Padding = new Padding(20, 14, 20, 12) };
        Label eyebrow = new Label { Text = "SMB LACAK BOT   /   SERVER CONTROL", ForeColor = Color.FromArgb(178, 225, 207), Font = new Font("Segoe UI", 8f, FontStyle.Bold), AutoSize = true, Location = new Point(0, 2) };
        Label title = new Label { Text = "Server Console", ForeColor = Color.White, Font = new Font("Segoe UI", 22f, FontStyle.Bold), AutoSize = true, Location = new Point(0, 24) };
        Label sub = new Label { Text = "Broker lokal · Tunnel Cloudflare · log waktu nyata", ForeColor = Color.FromArgb(214, 233, 225), Font = new Font("Segoe UI", 9f), AutoSize = true, Location = new Point(2, 65) };
        header.Controls.Add(eyebrow); header.Controls.Add(title); header.Controls.Add(sub);
        layout.Controls.Add(header, 0, 0);

        TableLayoutPanel statusGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Padding = new Padding(0, 12, 0, 0), BackColor = Canvas };
        statusGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); statusGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        Panel brokerCard = StatusCard("BROKER NODE.JS", "Memeriksa…", "HTTPS + WSS · port dari konfigurasi PC", out broker);
        Panel tunnelCard = StatusCard("CLOUDFLARE TUNNEL", "Memeriksa…", "Jalur aman dari internet ke broker PC", out tunnel);
        brokerCard.Margin = new Padding(0, 0, 7, 0); tunnelCard.Margin = new Padding(7, 0, 0, 0);
        statusGrid.Controls.Add(brokerCard, 0, 0); statusGrid.Controls.Add(tunnelCard, 1, 0);
        layout.Controls.Add(statusGrid, 0, 1);

        FlowLayoutPanel actions = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(0, 12, 0, 0), WrapContents = false, BackColor = Canvas };
        Button restart = ActionButton("Restart broker", Green, Color.White, 138);
        restart.Click += delegate { RestartBroker(); };
        Button dashboard = ActionButton("Buka dashboard", Color.White, Ink, 138);
        dashboard.Click += delegate { OpenUrl("https://lacaksmbbot.com/"); };
        Button config = ActionButton("Konfigurasi", Color.White, Ink, 115);
        config.Click += delegate { OpenFile(Path.Combine(root, ".env.local")); };
        Button logsFolder = ActionButton("Folder log", Color.White, Ink, 105);
        logsFolder.Click += delegate { OpenFile(logDirectory); };
        actions.Controls.Add(restart); actions.Controls.Add(dashboard); actions.Controls.Add(config); actions.Controls.Add(logsFolder);
        layout.Controls.Add(actions, 0, 2);

        Panel logPanel = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, Padding = new Padding(16) };
        Label logTitle = new Label { Text = "Log waktu nyata", ForeColor = Ink, Font = new Font("Segoe UI", 12f, FontStyle.Bold), AutoSize = true, Location = new Point(16, 13) };
        Label logSubtitle = new Label { Text = "Broker, launcher, dan Tunnel · log tersimpan lokal di .tools", ForeColor = Muted, Font = new Font("Segoe UI", 8f), AutoSize = true, Location = new Point(17, 38) };
        logs = new RichTextBox { Dock = DockStyle.Fill, ReadOnly = true, BorderStyle = BorderStyle.None, BackColor = Color.FromArgb(17, 35, 39), ForeColor = Color.FromArgb(213, 232, 225), Font = new Font("Consolas", 9f), DetectUrls = false, HideSelection = false, WordWrap = false, ScrollBars = RichTextBoxScrollBars.Both, Margin = new Padding(0) };
        Panel logHost = new Panel { Dock = DockStyle.Fill, Padding = new Padding(0, 66, 0, 0), BackColor = Color.White };
        logHost.Controls.Add(logs); logPanel.Controls.Add(logHost); logPanel.Controls.Add(logTitle); logPanel.Controls.Add(logSubtitle);
        layout.Controls.Add(logPanel, 0, 3);

        footer = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = Muted, Font = new Font("Segoe UI", 8f) };
        rootLabel = footer;
        layout.Controls.Add(footer, 0, 4);
        rootLabel.Text = "Folder server: " + root;
        return form;
    }

    private static Panel StatusCard(string heading, string value, string detail, out Label valueLabel)
    {
        Panel panel = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, Padding = new Padding(15), Margin = new Padding(0) };
        Label title = new Label { Text = heading, ForeColor = Muted, Font = new Font("Segoe UI", 8f, FontStyle.Bold), AutoSize = true, Location = new Point(15, 12) };
        valueLabel = new Label { Text = value, ForeColor = Ink, Font = new Font("Segoe UI", 14f, FontStyle.Bold), AutoSize = true, Location = new Point(15, 31) };
        Label note = new Label { Text = detail, ForeColor = Muted, Font = new Font("Segoe UI", 8f), AutoSize = true, Location = new Point(16, 61) };
        panel.Controls.Add(title); panel.Controls.Add(valueLabel); panel.Controls.Add(note);
        return panel;
    }

    private static Button ActionButton(string text, Color background, Color foreground, int width)
    {
        return new Button { Text = text, Width = width, Height = 34, Margin = new Padding(0, 0, 9, 0), FlatStyle = FlatStyle.Flat, BackColor = background, ForeColor = foreground, Font = new Font("Segoe UI", 8.5f, FontStyle.Bold), Cursor = Cursors.Hand };
    }

    private void ShowWindow()
    {
        if (window.WindowState == FormWindowState.Minimized) window.WindowState = FormWindowState.Normal;
        window.Show(); window.BringToFront(); window.Activate();
    }

    private void RegisterStartup()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(StartupKey, true))
                if (key != null) key.SetValue(StartupName, "\"" + Process.GetCurrentProcess().MainModule.FileName + "\"");
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
        if (ProbeHealth()) return;
        if (DateTime.UtcNow < nextNodeStart) return;

        string script = Path.Combine(root, "server", "index.mjs");
        string node = FindNode();
        if (!File.Exists(Path.Combine(root, ".env.local")))
        {
            AppendLog("fleet-launcher.log", "Broker tidak dimulai: .env.local belum ada.");
            nextNodeStart = DateTime.UtcNow.AddSeconds(20);
            return;
        }
        if (String.IsNullOrEmpty(node) || !File.Exists(script))
        {
            AppendLog("fleet-launcher.log", "Broker tidak dimulai: Node.js atau server/index.mjs tidak ditemukan.");
            nextNodeStart = DateTime.UtcNow.AddSeconds(20);
            return;
        }
        try
        {
            ProcessStartInfo start = new ProcessStartInfo(node, "\"" + script + "\"") { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            Process child = new Process { StartInfo = start, EnableRaisingEvents = true };
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) AppendLog("fleet-server.log", args.Data); };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) AppendLog("fleet-server-error.log", args.Data); };
            child.Exited += delegate { AppendLog("fleet-launcher.log", "Proses broker berhenti dengan kode " + SafeExitCode(child) + "."); };
            if (!child.Start()) throw new InvalidOperationException("node.exe gagal dimulai.");
            child.BeginOutputReadLine(); child.BeginErrorReadLine(); nodeProcess = child;
            File.WriteAllText(Path.Combine(logDirectory, "fleet-server.pid"), child.Id.ToString());
            nextNodeStart = DateTime.UtcNow.AddSeconds(10);
            AppendLog("fleet-launcher.log", "Broker Node.js dimulai, PID " + child.Id + ".");
        }
        catch (Exception error)
        {
            AppendLog("fleet-launcher.log", "Broker gagal dimulai: " + error.Message);
            nextNodeStart = DateTime.UtcNow.AddSeconds(20);
        }
    }

    private void RestartBroker()
    {
        try
        {
            if (nodeProcess != null && !nodeProcess.HasExited)
            {
                nodeProcess.Kill(); nodeProcess.WaitForExit(3000); nodeProcess.Dispose(); nodeProcess = null;
                AppendLog("fleet-launcher.log", "Restart broker diminta dari panel.");
            }
            else if (ProbeHealth())
            {
                AppendLog("fleet-launcher.log", "Broker sudah berjalan di luar launcher; restart dilewati agar proses lain tidak dihentikan.");
                MessageBox.Show("Broker terdeteksi aktif, tetapi bukan proses yang dimulai launcher ini. Hentikan proses lama terlebih dahulu sebelum memakai tombol restart.", "Broker sedang berjalan", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
        }
        catch (Exception error) { AppendLog("fleet-launcher.log", "Restart broker gagal: " + error.Message); }
        nextNodeStart = DateTime.MinValue;
        EnsureServer(); UpdateStatus();
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
        if (CloudflaredIsRunning())
        {
            if ((DateTime.UtcNow - lastExternalTunnelLog).TotalMinutes > 10)
            {
                AppendLog("fleet-launcher.log", "Proses Cloudflare Tunnel sudah berjalan sebagai service Windows.");
                lastExternalTunnelLog = DateTime.UtcNow;
            }
            return;
        }
        string executable = Path.Combine(root, ".tools", "cloudflared", "cloudflared.exe");
        string config = Path.Combine(root, ".tools", "cloudflared", "config.yml");
        if (!File.Exists(executable) || !File.Exists(config) || DateTime.UtcNow < nextTunnelStart) return;
        try
        {
            ProcessStartInfo start = new ProcessStartInfo(executable, "tunnel --config \"" + config + "\" run") { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            Process child = new Process { StartInfo = start, EnableRaisingEvents = true };
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) AppendLog("cloudflared.log", args.Data); };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) AppendLog("cloudflared.log", args.Data); };
            child.Exited += delegate { AppendLog("fleet-launcher.log", "Cloudflare Tunnel berhenti dengan kode " + SafeExitCode(child) + "."); };
            if (!child.Start()) throw new InvalidOperationException("cloudflared gagal dimulai.");
            child.BeginOutputReadLine(); child.BeginErrorReadLine(); tunnelProcess = child;
            nextTunnelStart = DateTime.UtcNow.AddSeconds(10);
            AppendLog("fleet-launcher.log", "Cloudflare Tunnel dimulai, PID " + child.Id + ".");
        }
        catch (Exception error)
        {
            AppendLog("fleet-launcher.log", "Cloudflare Tunnel gagal dimulai: " + error.Message);
            nextTunnelStart = DateTime.UtcNow.AddSeconds(20);
        }
    }

    private static bool CloudflaredIsRunning()
    {
        try { return Process.GetProcessesByName("cloudflared").Length > 0; }
        catch { return false; }
    }

    private bool ProbeHealth()
    {
        string host = ReadConfig("FLEET_BROKER_HOST", "127.0.0.1");
        if (host == "0.0.0.0" || host == "::") host = "127.0.0.1";
        string port = ReadConfig("FLEET_BROKER_PORT", "8787");
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("https://" + host + ":" + port + "/health");
            request.Timeout = 1200; request.ReadWriteTimeout = 1200;
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
                if (trimmed.StartsWith(name + "=", StringComparison.Ordinal)) return trimmed.Substring(name.Length + 1).Trim().Trim('"', '\'');
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
        bool tunnelOnline = CloudflaredIsRunning();
        string server = online ? "Broker online" : nodeProcess != null ? "Broker mulai / reconnect" : "Broker offline";
        string tunnel = tunnelOnline ? "Tunnel aktif" : File.Exists(Path.Combine(root, ".tools", "cloudflared", "config.yml")) ? "Tunnel menghubungkan" : "Tunnel offline";
        brokerValue.Text = server; brokerValue.ForeColor = online ? Green : Color.FromArgb(177, 91, 62);
        tunnelValue.Text = tunnel; tunnelValue.ForeColor = tunnelOnline ? Green : Color.FromArgb(177, 91, 62);
        statusItem.Text = server; tunnelItem.Text = tunnel;
        string tooltip = server + " · " + tunnel;
        tray.Text = tooltip.Length > 63 ? tooltip.Substring(0, 63) : tooltip;
        footerValue.Text = "Folder server: " + root + "    ·    Panel tetap aktif di system tray saat jendela ditutup.";
    }

    private void LoadExistingLogs()
    {
        string[] names = { "fleet-server.log", "fleet-server-error.log", "cloudflared.log", "fleet-launcher.log" };
        List<string> lines = new List<string>();
        foreach (string name in names)
        {
            string file = Path.Combine(logDirectory, name);
            try
            {
                if (!File.Exists(file)) continue;
                string[] sourceLines = File.ReadAllLines(file);
                int start = Math.Max(0, sourceLines.Length - 140);
                for (int i = start; i < sourceLines.Length; i++) lines.Add(sourceLines[i]);
            }
            catch { }
        }
        lines.Sort(String.CompareOrdinal);
        visibleLog.AddRange(lines);
        if (logView != null) logView.Text = String.Join(Environment.NewLine, lines.ToArray()) + (lines.Count > 0 ? Environment.NewLine : "");
        if (logView != null) { logView.SelectionStart = logView.TextLength; logView.ScrollToCaret(); }
    }

    private void AppendLog(string file, string text)
    {
        string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + text;
        try { lock (LogLock) File.AppendAllText(Path.Combine(logDirectory, file), line + Environment.NewLine); }
        catch { }
        string source = file == "cloudflared.log" ? "TUNNEL" : file == "fleet-server-error.log" ? "ERROR" : file == "fleet-launcher.log" ? "LAUNCHER" : "BROKER";
        AppendVisibleLog(line + "  [" + source + "]");
    }

    private void AppendVisibleLog(string line)
    {
        if (logView == null || logView.IsDisposed) return;
        if (logView.InvokeRequired)
        {
            try { logView.BeginInvoke(new Action<string>(AppendVisibleLog), line); }
            catch { }
            return;
        }
        visibleLog.Add(line);
        if (visibleLog.Count > 500)
        {
            visibleLog.RemoveAt(0);
            logView.Lines = visibleLog.ToArray();
        }
        else logView.AppendText(line + Environment.NewLine);
        logView.SelectionStart = logView.TextLength;
        logView.ScrollToCaret();
    }

    private void OpenFile(string path)
    {
        try
        {
            if (Directory.Exists(path)) Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            else { if (!File.Exists(path)) File.WriteAllText(path, ""); Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); }
        }
        catch (Exception error) { MessageBox.Show(error.Message, "SMB Server Console", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception error) { AppendLog("fleet-launcher.log", "URL tidak dapat dibuka: " + error.Message); }
    }

    private static int SafeExitCode(Process process) { try { return process.ExitCode; } catch { return -1; } }

    protected override void ExitThreadCore()
    {
        monitor.Stop();
        SetThreadExecutionState(EsContinuous);
        tray.Visible = false; tray.Dispose();
        allowClose = true;
        window.Close();
        base.ExitThreadCore();
    }
}
