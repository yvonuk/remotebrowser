export const MJPEG_BOUNDARY = 'mjpegboundary'

export type StreamClientWriter = (chunk: Uint8Array) => void

export class MJPEGStreamManager {
  private clients: Set<StreamClientWriter> = new Set()
  private latestFrame: Buffer | null = null

  public addStreamClient(writer: StreamClientWriter): () => void {
    this.clients.add(writer)

    if (this.latestFrame) {
      this.writeFrameToWriter(writer, this.latestFrame)
    }

    return () => {
      this.clients.delete(writer)
    }
  }

  public broadcastFrame(frameBuffer: Buffer): void {
    this.latestFrame = frameBuffer
    if (this.clients.size === 0) return

    for (const writer of this.clients) {
      this.writeFrameToWriter(writer, frameBuffer)
    }
  }

  private writeFrameToWriter(writer: StreamClientWriter, frameBuffer: Buffer): void {
    try {
      const headerStr = `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuffer.length}\r\n\r\n`
      const headerBytes = new TextEncoder().encode(headerStr)
      const footerBytes = new TextEncoder().encode('\r\n')

      writer(headerBytes)
      writer(new Uint8Array(frameBuffer.buffer, frameBuffer.byteOffset, frameBuffer.byteLength))
      writer(footerBytes)
    } catch {
      this.clients.delete(writer)
    }
  }

  public getClientCount(): number {
    return this.clients.size
  }

  public getLatestFrame(): Buffer | null {
    return this.latestFrame
  }
}
