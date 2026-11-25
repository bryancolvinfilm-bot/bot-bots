using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Speech.AudioFormat;
using System.Speech.Recognition;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Audio is 16 kHz mono PCM from the microphone selected in the chat window.
// Recognition stays in Windows' installed speech engine; nothing is written to disk.
internal static class WindowsSpeech
{
    // SAPI asks for stream length/position even for live input. Expose a forward-only
    // cursor and unknown end, without buffering the recording or inventing seek data.
    private sealed class LivePcmStream : Stream
    {
        private readonly Stream input;
        private long position;
        internal LivePcmStream(Stream value) { input = value; }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return Int64.MaxValue; } }
        public override long Position { get { return position; } set { if (value != position) throw new NotSupportedException(); } }
        public override int Read(byte[] buffer, int offset, int count) { int total = 0; while (total < count) { int read = input.Read(buffer, offset + total, count - total); if (read == 0) break; total += read; } position += total; return total; }
        public override long Seek(long offset, SeekOrigin origin) { long next = origin == SeekOrigin.Current ? position + offset : offset; if (origin == SeekOrigin.End || next != position) throw new NotSupportedException(); return position; }
        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
        protected override void Dispose(bool disposing) { if (disposing) input.Dispose(); base.Dispose(disposing); }
    }
    private static readonly object OutputLock = new object();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static void Emit(object value)
    {
        lock (OutputLock) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    }
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            bool probe = args.Length > 0 && args[0] == "--probe";
            string locale = args.Length > 1 ? args[1] : CultureInfo.CurrentUICulture.Name;
            var installed = SpeechRecognitionEngine.InstalledRecognizers();
            var selected = installed.FirstOrDefault(r => r.Culture.Name.Equals(locale, StringComparison.OrdinalIgnoreCase))
                ?? installed.FirstOrDefault(r => r.Culture.TwoLetterISOLanguageName.Equals(locale.Split('-')[0], StringComparison.OrdinalIgnoreCase))
                ?? installed.FirstOrDefault();
            if (selected == null)
            {
                Emit(new { type = "capabilities", available = false, engine = "Windows speech", local = true,
                    error = "Install a speech recognition language in Windows Settings, then reopen Bot-Bots." });
                return 1;
            }
            if (probe)
            {
                Emit(new { type = "capabilities", available = true, engine = "Windows speech", local = true, locale = selected.Culture.Name });
                return 0;
            }
            using (var finished = new ManualResetEvent(false))
            using (var recognizer = new SpeechRecognitionEngine(selected))
            {
                recognizer.LoadGrammar(new DictationGrammar());
                recognizer.InitialSilenceTimeout = TimeSpan.Zero;
                recognizer.BabbleTimeout = TimeSpan.Zero;
                recognizer.EndSilenceTimeout = TimeSpan.FromMilliseconds(500);
                recognizer.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(800);
                recognizer.SpeechHypothesized += (sender, e) => Emit(new { type = "transcript", text = e.Result.Text, final = false });
                recognizer.SpeechRecognized += (sender, e) => Emit(new { type = "transcript", text = e.Result.Text, final = true });
                recognizer.SpeechRecognitionRejected += (sender, e) => Emit(new { type = "transcript", text = "", final = false });
                recognizer.RecognizeCompleted += (sender, e) => {
                    if (e.Error != null) Emit(new { type = "error", message = "Windows speech could not process the microphone audio. Try starting dictation again." });
                    finished.Set();
                };
                recognizer.SetInputToAudioStream(new LivePcmStream(Console.OpenStandardInput()), new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
                recognizer.RecognizeAsync(RecognizeMode.Multiple);
                Emit(new { type = "ready" });
                finished.WaitOne();
                Emit(new { type = "ended" });
            }
            return 0;
        }
        catch (Exception exception)
        {
            if (args.Contains("--diagnostic")) Console.Error.WriteLine(exception.ToString());
            Emit(new { type = "error", message = "Windows speech recognition is unavailable. Check that a speech recognition language is installed in Windows Settings." });
            return 1;
        }
    }
}
