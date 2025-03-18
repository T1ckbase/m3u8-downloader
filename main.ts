// m3u8-downloader.ts - A Deno script for downloading HLS streams (without temporary files, concurrent downloads)
import { dirname } from '@std/path';
import { ensureDir } from '@std/fs';
import { ProgressBar } from '@std/cli/unstable-progress-bar';

// Main function to handle the download process
async function downloadM3U8(url: string, outputFile: string, concurrency: number = 5): Promise<void> {
  console.log(`Starting download of M3U8 stream: ${url}`);
  console.log(`Output file: ${outputFile}`);
  console.log(`Concurrency: ${concurrency}`);

  try {
    // Fetch the main m3u8 playlist
    const mainPlaylist = await fetchText(url);

    // Check if it's a master playlist (containing multiple variants)
    if (mainPlaylist.includes('#EXT-X-STREAM-INF')) {
      console.log('Detected master playlist. Selecting highest quality stream...');
      const streamUrl = extractHighestQualityStream(mainPlaylist, url);
      // Download the selected stream
      return downloadM3U8(streamUrl, outputFile, concurrency);
    }

    // At this point, we have a regular media playlist
    // Ensure the output directory exists
    await ensureDir(dirname(outputFile));

    // Process the segments and download them
    await processMediaPlaylist(mainPlaylist, url, outputFile, concurrency);

    console.log(`✅ Download completed: ${outputFile}`);
  } catch (error) {
    console.error(`❌ Error downloading M3U8: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// Fetches the text content from a URL
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return await response.text();
}

// Extracts the highest quality stream from a master playlist
function extractHighestQualityStream(playlist: string, baseUrl: string): string {
  const lines = playlist.split('\n');
  let highestBandwidth = 0;
  let selectedStreamUrl = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('#EXT-X-STREAM-INF')) {
      // Extract bandwidth information
      const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
      if (bandwidthMatch) {
        const bandwidth = parseInt(bandwidthMatch[1]);
        if (bandwidth > highestBandwidth) {
          highestBandwidth = bandwidth;
          // The next line should be the URI
          const streamUrl = lines[i + 1];
          selectedStreamUrl = resolveUrl(streamUrl, baseUrl);
        }
      }
    }
  }

  console.log(`Selected stream with bandwidth ${highestBandwidth}`);
  return selectedStreamUrl;
}

// Processes the media playlist and downloads all segments
async function processMediaPlaylist(playlist: string, baseUrl: string, outputFile: string, concurrency: number): Promise<void> {
  const lines = playlist.split('\n');
  const segments: string[] = [];

  // Extract segment URLs
  for (const line of lines) {
    if (!line.startsWith('#') && line.trim().length > 0) {
      segments.push(resolveUrl(line, baseUrl));
    }
  }

  console.log(`Found ${segments.length} segments to download`);

  // Create the output file
  const file = await Deno.open(outputFile, { write: true, create: true, truncate: true });

  // Initialize progress bar with custom formatting
  const bar = new ProgressBar(Deno.stdout.writable, {
    max: segments.length,
    fmt(x) {
      const fileName = outputFile.split('/').pop() || outputFile;
      const percent = Math.floor((x.value / x.max) * 100);
      return `${x.styledTime()} ${x.progressBar} ${percent}% [${x.value}/${x.max}] segments`;
    },
    // barLength: 40,
    // fillChar: '█',
    // emptyChar: '░',
  });

  try {
    // Download and write to file in batches
    for (let i = 0; i < segments.length; i += concurrency) {
      const batch = segments.slice(i, i + concurrency);
      const promises = batch.map(async (segmentUrl, index) => {
        const batchIndex = i + index;
        return {
          index: batchIndex,
          data: await downloadSegment(segmentUrl),
        };
      });

      // Wait for all downloads in the current batch to complete
      const results = await Promise.all(promises);

      // Write to file in the original order
      results.sort((a, b) => a.index - b.index);
      for (const result of results) {
        await file.write(result.data);
        bar.add(1);
      }
    }
  } finally {
    // Ensure the file is closed
    file.close();
    // Complete the progress bar
    await bar.end();
  }
}

// Downloads a single segment and returns the data
async function downloadSegment(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch segment ${url}: ${response.status} ${response.statusText}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

// Resolves a relative URL to an absolute URL
function resolveUrl(url: string, baseUrl: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  // Get the base directory of baseUrl
  const baseParts = baseUrl.split('/');
  baseParts.pop(); // Remove the last part (filename)
  const baseDir = baseParts.join('/');

  if (url.startsWith('/')) {
    // Absolute path from domain root
    const domain = baseUrl.match(/^(https?:\/\/[^\/]+)/);
    return domain ? domain[1] + url : url;
  }

  // Relative path
  return `${baseDir}/${url}`;
}

// Command-line interface
if (import.meta.main) {
  const args = Deno.args;

  if (args.length < 2) {
    console.log('Usage: deno task download <m3u8-url> <output-file> [concurrency]');
    Deno.exit(1);
  }

  const m3u8Url = args[0];
  const outputFile = args[1];
  const concurrency = args[2] ? parseInt(args[2]) : 10; // Default concurrency is 10

  downloadM3U8(m3u8Url, outputFile, concurrency)
    .catch((err) => {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      Deno.exit(1);
    });
}

// Export the main function for use as a module
export { downloadM3U8 };
