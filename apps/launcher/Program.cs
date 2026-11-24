using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("Bot-Bots Launcher")]
[assembly: AssemblyProduct("Bot-Bots")]
[assembly: AssemblyDescription("Opens the latest built Bot-Bots desktop app.")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace BotBots
{
    internal static class Launcher
    {
        // The launcher lives beside data/ and release/, so it keeps working across app upgrades.
        internal static string FindApp(string root)
        {
            string releases = Path.Combine(root, "release");
            string latest = null;
            Version latestVersion = null;
            if (Directory.Exists(releases))
            {
                foreach (string directory in Directory.GetDirectories(releases))
                {
                    Version version;
                    string name = Path.GetFileName(directory).TrimStart('v', 'V');
                    string executable = Path.Combine(directory, "win-unpacked", "Bot-Bots.exe");
                    if (Version.TryParse(name, out version) && IsPackagedApp(executable) &&
                        (latestVersion == null || version.CompareTo(latestVersion) > 0))
                    {
                        latestVersion = version;
                        latest = executable;
                    }
                }
                if (latest != null) return latest;
                string unversioned = Path.Combine(releases, "win-unpacked", "Bot-Bots.exe");
                if (IsPackagedApp(unversioned)) return unversioned;
            }
            string electron = Path.Combine(root, "node_modules", "electron", "dist", "electron.exe");
            return File.Exists(electron) && File.Exists(Path.Combine(root, "dist", "desktop", "main.js"))
                ? electron : null;
        }

        private static bool IsPackagedApp(string executable)
        {
            return File.Exists(executable) &&
                File.Exists(Path.Combine(Path.GetDirectoryName(executable), "resources", "app.asar"));
        }

        [STAThread]
        private static void Main()
        {
            try
            {
                string root = AppDomain.CurrentDomain.BaseDirectory;
                string executable = FindApp(root);
                if (executable == null)
                {
                    MessageBox.Show(
                        "Bot-Bots could not find its desktop app. Keep this launcher in the Bot-Bots folder with the release files.\n\nIf running from source, build and package the desktop app first; see README.md.",
                        "Bot-Bots", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                var start = new ProcessStartInfo(executable);
                start.WorkingDirectory = root;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.EnvironmentVariables["BOT_BOTS_DATA_DIR"] = Path.Combine(root, "data");
                start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                if (String.Equals(Path.GetFileName(executable), "electron.exe", StringComparison.OrdinalIgnoreCase))
                    start.Arguments = ".";
                using (Process child = Process.Start(start)) { }
            }
            catch (Exception error)
            {
                MessageBox.Show("Bot-Bots could not open.\n\n" + error.Message,
                    "Bot-Bots", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
