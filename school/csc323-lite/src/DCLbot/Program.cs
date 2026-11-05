using System;
using System.Windows.Forms;

namespace DCLbot
{
    /// <summary>
    /// Application entry point (composition root).
    /// Builds the object graph and starts the Windows Forms message loop.
    /// </summary>
    internal static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // v0.8.0 - the safety net: an unexpected exception on the UI thread
            // (including inside async/await continuations) now shows a message
            // box and the application KEEPS RUNNING. Before this, one bad
            // hiccup anywhere silently killed the whole process - the reported
            // "app completely exits after one message" class of failure is
            // structurally impossible now.
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (sender, e) =>
            {
                MessageBox.Show(
                    "Unexpected problem: " + e.Exception.Message + Environment.NewLine + Environment.NewLine
                    + "The app keeps running - you can send another message.",
                    "DCLbot",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            };

            Application.Run(new UI.frmChat());
        }
    }
}
