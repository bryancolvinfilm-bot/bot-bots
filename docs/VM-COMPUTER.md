# Future Computer tab: Linux VM research

Researched November 23, 2026. This is a planned milestone, not an installed VM or an enabled app capability. The existing embedded Chromium panel is called **Browser**. Reserve **Computer** for a full guest desktop that both a bot and its owner can operate.

## Recommended prototype

Use **QEMU + Debian stable amd64 + Xfce + Google Chrome + Xfce Terminal**, with **noVNC** embedded in the app. This is an engineering recommendation based on the capabilities below; boot time, idle memory and interaction latency still need measurement on this machine.

QEMU is open source under GPLv2, with component-specific licenses. Its system emulator supports Windows Hypervisor Platform (WHPX) on Windows, KVM on Linux and Hypervisor Framework on macOS, and exposes a machine-readable management API, QMP. That makes it a plausible backend for both this Windows desktop and a future Linux host. Check accelerator availability explicitly; software emulation should be an opt-in fallback because its performance needs separate evaluation. [QEMU introduction](https://www.qemu.org/docs/master/system/introduction.html), [license](https://www.qemu.org/docs/master/about/license.html).

Debian stable offers an established package ecosystem. Xfce deliberately targets low resource use with a familiar desktop, launcher, window manager and file manager. Debian itself recommends lighter desktops such as Xfce for limited hardware. Google's current Linux requirements include 64-bit Debian 10 and later. Use a supported stable release and install Chrome from Google's package source during image provisioning; verify redistribution terms before shipping an image containing Chrome. [Debian release information](https://www.debian.org/releases/stable/), [desktop hardware guidance](https://www.debian.org/releases/stable/amd64/ch03s04.en.html), [Xfce](https://www.xfce.org/about/), [Chrome requirements](https://support.google.com/chrome/a/answer/7100626?hl=en).

Start the prototype with **2 virtual CPUs, 4 GiB RAM, a 24 GiB growable qcow2 disk and a 1280 x 800 desktop**. These are proposed test allocations, not measured requirements or an assertion of instant startup. Compare a 2 GiB allocation for simple pages, then test Chrome with realistic tabs and terminal work. QEMU supports growing images and VM snapshots. [QEMU disk images](https://www.qemu.org/docs/master/system/images.html).

noVNC provides an open-source JavaScript VNC client for modern desktop and mobile browsers. QEMU supplies the guest's graphical console over VNC and supports a WebSocket listener directly, so a separate websockify process may be unnecessary. Put console access through the authenticated Bot-Bots host, keep the underlying VNC/QMP endpoints local, and enforce operator access and an exclusive input lease there. The noVNC display alone does not implement bot control or takeover arbitration. [noVNC](https://novnc.com/info.html), [QEMU WebSocket options](https://www.qemu.org/docs/master/system/invocation.html), [VNC access guidance](https://www.qemu.org/docs/master/system/vnc-security.html).

## Alternatives considered

| Option | Fit for Bot-Bots |
| --- | --- |
| QEMU with Debian/Xfce and noVNC | Recommended full-VM prototype. Cross-platform accelerators, a graphical console, management API and persistent disks suit a desktop users can take over. |
| Firecracker | Useful candidate for future Linux-hosted background execution. Its documented devices omit a graphical adapter, and it uses Linux KVM. A streamed desktop could be built inside it, but that adds work for this Windows-first interactive requirement. Its advertised VMM overhead excludes a complete Linux desktop and Chrome. [Firecracker architecture and FAQ](https://firecracker-microvm.github.io/). |
| LinuxServer Webtop | A quicker streamed Linux desktop experiment with Debian/Xfce images. It is a container deployment, so it does not supply a standalone guest kernel/VM boundary. It could be hosted inside a VM later. Evaluate its authentication and container permissions before integrating. [Webtop project](https://github.com/linuxserver/docker-webtop). |

## Milestone acceptance

1. Offer a separate **Computer** tab alongside **Browser**, with an optional download/setup flow and clear CPU, memory and disk controls. Start with one on-demand shared VM; queue competing bot jobs. Consider per-bot disk overlays after the basic lifecycle works.
2. Boot into a clean Xfce desktop with working Google Chrome, terminal, keyboard, pointer, scrolling, resizing and deliberate clipboard paste. Display boot/provisioning failures and virtualization requirements without freezing the app.
3. **Take control** acquires exclusive human input and pauses new bot desktop actions; **Resume bots** releases it explicitly. A remote operator gets the same desktop through the authenticated host. A viewer can watch but cannot type or click. Bot actions re-check the lease before execution.
4. Add a guest desktop adapter for screenshot, pointer, keyboard and guest-terminal tools. Keep existing host Terminal clearly labelled and separate from guest Terminal. Browser automation must target the guest Chrome rather than accidentally driving the existing host panel.
5. Preserve guest files across stop/start, support a clean reset with confirmation, and record which bot is using the VM. Keep guest credentials and host credentials separate; use deliberate file transfer instead of mounting the entire host home directory.
6. Measure cold/warm boot, idle and browsing memory, typing latency, concurrent app responsiveness, takeover while a bot works, shutdown, crash recovery and reset on Windows/WHPX and Linux/KVM. Future VM uses can add applications and tools behind the same guest adapter.

No QEMU binary, Linux image, hypervisor feature, Chrome package or VM service was installed as part of this research.
