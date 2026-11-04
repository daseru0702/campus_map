/* global jsQR */
// 자전거 QR 스캔 모달.
// QR 내용은 "…/index.html?bike=B-001" 형태의 주소라서, 휴대폰 기본 카메라로 찍어도 앱이 열리며 대여 화면이 뜬다.
// 앱 안에서는 카메라로 직접 스캔하거나, 카메라를 쓸 수 없으면 자전거 번호를 입력한다.

export const parseBikeId = (text) => {
  const m = String(text).toUpperCase().match(/B-?(\d{1,3})/);
  return m ? `B-${m[1].padStart(3, '0')}` : null;
};

export function openScanner(onResult) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true" aria-label="QR 스캔">
      <div class="modal-head"><b>자전거 QR 스캔</b><button class="close" data-x aria-label="닫기">×</button></div>
      <div class="scan-view"><video playsinline muted></video><div class="scan-frame"></div>
        <div class="scan-msg muted small">카메라를 켜는 중…</div></div>
      <form class="scan-manual">
        <input name="code" placeholder="자전거 번호 입력 (예: B-001)" autocomplete="off" />
        <button class="btn primary">대여</button>
      </form>
    </div>`;
  document.body.appendChild(modal);

  const video = modal.querySelector('video');
  const msg = modal.querySelector('.scan-msg');
  let stream = null;
  let raf = 0;
  let closed = false;

  const close = () => {
    closed = true;
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    modal.remove();
  };
  const finish = (text) => {
    const id = parseBikeId(text);
    if (!id) {
      msg.textContent = '자전거 QR이 아닙니다. 다시 스캔해 주세요.';
      return false;
    }
    close();
    onResult(id);
    return true;
  };

  modal.querySelector('[data-x]').addEventListener('click', close);
  modal.addEventListener('click', (e) => e.target === modal && close());
  modal.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    finish(e.target.code.value);
  });

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
      msg.textContent = '카메라를 사용할 수 없습니다. 자전거 번호를 입력해 주세요.';
      modal.querySelector('input').focus();
      return;
    }
    if (closed) return stream.getTracks().forEach((t) => t.stop());
    video.srcObject = stream;
    await video.play();
    msg.textContent = '자전거에 붙은 QR 코드를 네모 안에 맞춰 주세요.';

    const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const scan = async () => {
      if (closed) return;
      if (video.readyState >= 2) {
        let text = null;
        if (detector) {
          const codes = await detector.detect(video).catch(() => []);
          text = codes[0]?.rawValue;
        } else if (window.jsQR) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          text = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data;
        }
        if (text && finish(text)) return;
      }
      raf = requestAnimationFrame(scan);
    };
    scan();
  })();
}
