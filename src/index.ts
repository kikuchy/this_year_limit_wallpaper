import { initialize, svg2png } from 'svg2png-wasm';
// @ts-ignore
import svg2pngWasm from 'svg2png-wasm/svg2png_wasm_bg.wasm';
import * as jpeg from 'jpeg-js';
import { Buffer } from 'node:buffer';

export interface Env {
    ASSETS: {
        fetch: (request: Request) => Promise<Response>;
    };
}

let wasmInitialized = false;
let robotoFontBuffer: Uint8Array | null = null;
let robotoBase64: string | null = null;

// Basic in-memory rate limiting (per-isolate)
const ipCache = new Map<string, { count: number, resetAt: number }>();
const RATE_LIMIT = 20; // Allow 20 requests per minute per isolate
const WINDOW_MS = 60 * 1000;

function isRateLimited(ip: string | null): boolean {
    if (!ip) return false;
    const now = Date.now();
    const entry = ipCache.get(ip);

    if (!entry || now > entry.resetAt) {
        ipCache.set(ip, { count: 1, resetAt: now + WINDOW_MS });
        return false;
    }

    entry.count++;
    return entry.count > RATE_LIMIT;
}

// Memory cleanup for ipCache
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of ipCache.entries()) {
        if (now > entry.resetAt) {
            ipCache.delete(ip);
        }
    }
}, 5 * 60 * 1000); // Every 5 minutes

async function initializeWasm(requestUrl: string, env: Env) {
    if (!wasmInitialized) {
        // @ts-ignore
        globalThis.Buffer = Buffer;
        await initialize(svg2pngWasm);
        wasmInitialized = true;
    }

    if (!robotoFontBuffer) {
        const url = new URL(requestUrl);
        const fontUrl = `${url.origin}/Roboto-Bold.ttf`;
        try {
            const fontRes = await env.ASSETS.fetch(new Request(fontUrl));
            if (fontRes.ok) {
                const arrayBuffer = await fontRes.arrayBuffer();
                robotoFontBuffer = new Uint8Array(arrayBuffer);
                robotoBase64 = Buffer.from(robotoFontBuffer).toString('base64');
            } else {
                console.error("Font fetch failed with status:", fontRes.status);
            }
        } catch (e) {
            console.error("Error fetching Roboto font:", e);
        }
    }
}

function getImageDimensions(buffer: Uint8Array): { width: number; height: number } {
    const buf = Buffer.from(buffer);
    try {
        // PNG
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
            const w = buf.readUInt32BE(16);
            const h = buf.readUInt32BE(20);
            console.log(`Detected PNG: ${w}x${h}`);
            return { width: w, height: h };
        }
        // JPEG
        if (buf[0] === 0xff && buf[1] === 0xd8) {
            let offset = 2;
            while (offset < buf.length) {
                const marker = buf.readUInt16BE(offset);
                const length = buf.readUInt16BE(offset + 2);
                if ((marker >= 0xffc0 && marker <= 0xffc3) || (marker >= 0xffc5 && marker <= 0xffc7) || (marker >= 0xffc9 && marker <= 0xffcb) || (marker >= 0xffcd && marker <= 0xffcf)) {
                    const h = buf.readUInt16BE(offset + 5);
                    const w = buf.readUInt16BE(offset + 7);
                    console.log(`Detected JPEG: ${w}x${h}`);
                    return { width: w, height: h };
                }
                offset += length + 2;
            }
        }
    } catch (e) {
        console.error("Error detecting image dimensions:", e);
    }
    console.log("Fallback to default dimensions: 1438x2592");
    return { width: 1438, height: 2592 };
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const clientIp = request.headers.get("cf-connecting-ip");
        if (isRateLimited(clientIp)) {
            return new Response("Too Many Requests", { status: 429 });
        }

        const url = new URL(request.url);

        if (url.pathname.endsWith(".png") || url.pathname.endsWith(".ttf") || url.pathname.endsWith(".wasm")) {
            return env.ASSETS.fetch(request);
        }

        await initializeWasm(request.url, env);

        const now = new Date();
        const year = now.getFullYear();
        const startOfYear = new Date(year, 0, 1);
        const endOfYear = new Date(year, 11, 31);
        const dayOfYear = Math.floor((now.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        const totalDays = Math.floor((endOfYear.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        const remainingDays = totalDays - dayOfYear;
        const progressPercentage = (dayOfYear / totalDays) * 100;

        let width = 1438;
        let height = 2592;
        let bgImageUrl = "";
        let responseType = "image/png";

        if (request.method === "POST") {
            const contentLength = request.headers.get("content-length");
            // Strict 5MB limit based on Content-Length header
            if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) {
                return new Response("Request entity too large (max 5MB)", { status: 413 });
            }

            try {
                const formData = await request.formData();
                const imageBlob = formData.get("image");

                if (imageBlob && typeof imageBlob !== 'string' && 'arrayBuffer' in (imageBlob as any)) {
                    const blob = imageBlob as any;

                    // Double check size just in case Content-Length was missing or spoofed
                    if (blob.size > 5 * 1024 * 1024) {
                        return new Response("File size too large (max 5MB)", { status: 413 });
                    }

                    const arrayBuffer = await blob.arrayBuffer();
                    const uint8 = new Uint8Array(arrayBuffer);

                    // Validate image type via magic bytes
                    const isPng = uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4e && uint8[3] === 0x47;
                    const isJpeg = uint8[0] === 0xff && uint8[1] === 0xd8;

                    if (!isPng && !isJpeg) {
                        return new Response("Unsupported image format. Only PNG and JPEG are allowed.", { status: 415 });
                    }

                    const dims = getImageDimensions(uint8);

                    // Limit dimensions to 4096px to prevent resource exhaustion
                    if (dims.width > 4096 || dims.height > 4096) {
                        return new Response("Image dimensions too large (max 4096px)", { status: 400 });
                    }

                    width = dims.width;
                    height = dims.height;
                    bgImageUrl = `data:${isPng ? "image/png" : "image/jpeg"};base64,${Buffer.from(arrayBuffer).toString('base64')}`;
                    responseType = isPng ? "image/png" : "image/jpeg";
                }
            } catch (e) {
                console.error("Error parsing form data:", e);
            }
        }

        if (!bgImageUrl) {
            return Response.redirect("https://github.com/kikuchy/this_year_limit_wallpaper", 302);
        }

        // --- Layout Engine ---
        // Reference dimensions: 1438 x 2592
        // We use the smaller of the two scales to ensure the indicator fits in both dimensions.
        const scale = Math.min(width / 1438, height / 2592);

        // Indicator box sizing (more conservative 85% width)
        const indicatorWidth = width * 0.85;
        const boxPadding = 48 * scale;

        // Inner components sizing
        const titleFontSize = 48 * scale;
        const mainFontSize = 120 * scale;
        const subFontSize = 36 * scale;
        const progressHeight = 16 * scale;
        const tileGap = 8 * scale;

        // Calculate tileSize to fit perfectly within indicatorWidth (padding included)
        const availableGridWidth = indicatorWidth - 2 * boxPadding;
        const tileSize = (availableGridWidth - 52 * tileGap) / 53;

        // Sum up parts to get box height
        const titlePartArea = 110 * scale;
        const counterPartArea = 130 * scale;
        const progressPartArea = 30 * scale;
        const tileGridArea = 7 * (tileSize + tileGap) + 10 * scale;
        const bottomPadding = 40 * scale;

        const indicatorHeight = titlePartArea + counterPartArea + progressPartArea + tileGridArea + bottomPadding;
        const indicatorX = (width - indicatorWidth) / 2;
        const centerX = width / 2;

        // Position it at 65% of screen height, but ensure it doesn't overflow bottom
        let indicatorY = height * 0.65;
        const bottomMargin = 40 * scale;
        if (indicatorY + indicatorHeight > height - bottomMargin) {
            indicatorY = height - bottomMargin - indicatorHeight;
        }

        // Tile generation
        let tiles = "";
        const gridStartX = centerX - availableGridWidth / 2;
        const gridStartY = indicatorY + titlePartArea + counterPartArea + progressPartArea + 10 * scale;

        for (let i = 0; i < totalDays; i++) {
            const col = Math.floor(i / 7);
            const row = i % 7;
            const x = gridStartX + col * (tileSize + tileGap);
            const y = gridStartY + row * (tileSize + tileGap);
            const isPassed = i < dayOfYear;
            const tileColor = isPassed ? "rgba(255, 255, 255, 0.15)" : "#00f0ff";
            tiles += `<rect x="${x}" y="${y}" width="${tileSize}" height="${tileSize}" rx="${2 * scale}" fill="${tileColor}" />\n`;
        }

        const fontName = 'Roboto';
        const fontStyle = robotoBase64 ? `
        <style>
            @font-face {
                font-family: '${fontName}';
                src: url(data:font/ttf;base64,${robotoBase64});
                font-weight: normal;
                font-style: normal;
            }
            text {
                font-family: '${fontName}', sans-serif;
            }
        </style>` : '';

        const progressY = indicatorY + titlePartArea + counterPartArea + 10 * scale;

        console.log(width, height, indicatorX, indicatorY, indicatorWidth, indicatorHeight);
        const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
	<defs>${fontStyle}</defs>
	<image href="${bgImageUrl}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" />
	<rect x="${indicatorX}" y="${indicatorY}" width="${indicatorWidth}" height="${indicatorHeight}" rx="${32 * scale}" fill="rgba(0, 0, 0, 0.65)" stroke="rgba(255, 255, 255, 0.2)" stroke-width="${1.5 * scale}" />
	
    <text x="${centerX}" y="${indicatorY + 70 * scale}" text-anchor="middle" font-weight="bold" font-size="${titleFontSize}" fill="white">${year} Year Remaining</text>
	
    <text x="${centerX}" y="${indicatorY + 180 * scale}" text-anchor="middle" fill="white">
        <tspan font-weight="900" font-size="${mainFontSize}" fill="#00f0ff">${remainingDays}</tspan>
        <tspan font-weight="500" font-size="${subFontSize}" fill="rgba(255, 255, 255, 0.8)" dx="${10 * scale}" dy="${-25 * scale}">days left</tspan>
        <tspan font-weight="bold" font-size="${titleFontSize}" fill="white" dx="${30 * scale}">${progressPercentage.toFixed(1)}%</tspan>
    </text>

    <rect x="${gridStartX}" y="${progressY}" width="${availableGridWidth}" height="${progressHeight}" rx="${progressHeight / 2}" fill="rgba(255, 255, 255, 0.1)" />
	<rect x="${gridStartX}" y="${progressY}" width="${availableGridWidth * (dayOfYear / totalDays)}" height="${progressHeight}" rx="${progressHeight / 2}" fill="#00f0ff" />
	${tiles}
</svg>
		`.trim();

        if (url.searchParams.get("format") === "svg") {
            return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });
        }

        const pngBuffer = await svg2png(svg, {
            width: width,
            height: height,
            fonts: robotoFontBuffer ? [robotoFontBuffer] : [],
            defaultFontFamily: { serifFamily: fontName }
        });

        console.log(`Successfully generated PNG: ${width}x${height}`);

        return new Response(pngBuffer, {
            headers: {
                "Content-Type": "image/png",
                "Cache-Control": "no-cache, no-store, must-revalidate",
            },
        });
    },
};
