/**
 * Camera barcode scanning (H4), optional and HTTPS-only.
 *
 * A camera needs a secure context. On a branch LAN served over plain HTTP the browser will not grant
 * `getUserMedia`, so the camera affordance is hidden entirely rather than shown and then failing.
 * `cameraSupported()` is the single gate the UI checks.
 *
 * `@zxing/library` is an OPTIONAL dependency: it is imported dynamically only when the camera is
 * actually started, so a build without it (or a test that never opens the camera) is unaffected.
 */

/** True only in a browser, in a secure context, with a camera API present. */
export function cameraSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const secure = typeof window.isSecureContext === 'boolean' ? window.isSecureContext : false;
  const hasMedia =
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof navigator.mediaDevices.getUserMedia === 'function';
  return secure && hasMedia;
}

export interface CameraScanOptions {
  /** The element the preview video is rendered into. */
  video: HTMLVideoElement;
  /** Called once per decoded barcode. */
  onResult: (code: string) => void;
  onError?: (error: Error) => void;
}

export interface CameraScanner {
  stop: () => void;
}

/**
 * Start decoding barcodes from the camera into `options.video`. Throws when the camera is not
 * supported, so a caller must check `cameraSupported()` first.
 */
export async function startCameraScan(options: CameraScanOptions): Promise<CameraScanner> {
  if (!cameraSupported()) {
    throw new Error('camera scanning requires a secure context (HTTPS)');
  }

  const { BrowserMultiFormatReader } = await import('@zxing/library');
  const reader = new BrowserMultiFormatReader();
  let stopped = false;

  try {
    await reader.decodeFromVideoDevice(null, options.video, (result, error) => {
      if (stopped) return;
      if (result) {
        options.onResult(result.getText());
        return;
      }
      // ZXing reports a not-found error on every frame with no barcode; that is not a real error.
      if (error && error.name !== 'NotFoundException' && options.onError) {
        options.onError(error as Error);
      }
    });
  } catch (error) {
    throw new Error(`could not start the camera: ${(error as Error).message}`);
  }

  return {
    stop: () => {
      stopped = true;
      try {
        reader.reset();
      } catch {
        /* the reader may already be stopped */
      }
    },
  };
}
