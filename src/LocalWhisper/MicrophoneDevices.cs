using System.Runtime.InteropServices;
using System.Text.Json.Serialization;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace LocalWhisper;

internal sealed record MicrophoneDevice(string Id, string Name, [property: JsonIgnore] int DeviceNumber);

internal static class MicrophoneDevices
{
    // Windows maps legacy waveIn devices to persistent Core Audio endpoint IDs.
    // https://learn.microsoft.com/windows/win32/coreaudio/device-roles-for-legacy-windows-multimedia-applications
    private const uint QueryEndpointId = 0x0800 + 17, QueryEndpointIdSize = 0x0800 + 18;
    [DllImport("winmm.dll")]
    private static extern uint waveInMessage(nint device, uint message, nint parameter1, nint parameter2);

    public static MicrophoneDevice[] Available()
    {
        var devices = new List<MicrophoneDevice>();
        using var endpoints = new MMDeviceEnumerator();
        for (var number = 0; number < WaveIn.DeviceCount; number++)
        {
            var id = EndpointId(number);
            if (string.IsNullOrEmpty(id)) continue;
            var name = WaveIn.GetCapabilities(number).ProductName;
            try { using var endpoint = endpoints.GetDevice(id); name = endpoint.FriendlyName; }
            catch { /* Keep the waveIn name if the endpoint disappeared during enumeration. */ }
            devices.Add(new MicrophoneDevice(id, name, number));
        }
        return devices.ToArray();
    }

    public static int Resolve(string selectedId) => string.IsNullOrEmpty(selectedId) ? -1 : Resolve(selectedId, Available());

    internal static int Resolve(string selectedId, IReadOnlyList<MicrophoneDevice> devices)
    {
        if (string.IsNullOrEmpty(selectedId)) return -1;
        return devices.FirstOrDefault(device => device.Id.Equals(selectedId, StringComparison.OrdinalIgnoreCase))?.DeviceNumber
            ?? throw new InvalidOperationException("The selected microphone is unavailable. Reconnect it or choose System default in Settings.");
    }

    private static string? EndpointId(int number)
    {
        var sizePointer = Marshal.AllocHGlobal(IntPtr.Size);
        nint buffer = 0;
        try
        {
            Marshal.WriteIntPtr(sizePointer, 0);
            if (waveInMessage(number, QueryEndpointIdSize, sizePointer, 0) != 0) return null;
            var bytes = Marshal.ReadInt32(sizePointer);
            if (bytes < 2 || bytes > 65536) return null;
            buffer = Marshal.AllocHGlobal(bytes);
            if (waveInMessage(number, QueryEndpointId, buffer, bytes) != 0) return null;
            return Marshal.PtrToStringUni(buffer);
        }
        finally { if (buffer != 0) Marshal.FreeHGlobal(buffer); Marshal.FreeHGlobal(sizePointer); }
    }
}
