/**
 * HTML fixture strings for parser unit tests.
 * Modeled after real OpenGrok page structure.
 */

export const PROJECTS_PAGE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Projects Fixture</title>
</head>
<body>
  <form>
    <select id="project">
      <optgroup label="Main Releases">
        <option value="release-2.x">release-2.x</option>
        <option value="release-2.x-win">release-2.x-win</option>
      </optgroup>
      <optgroup label="Legacy">
        <option value="v1.8-stable">v1.8-stable</option>
      </optgroup>
    </select>
  </form>
</body>
</html>
`;

export const DIRECTORY_LISTING_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Directory Listing Fixture</title>
</head>
<body>
  <table id="dirlist">
    <thead><tr><th>Name</th><th>Size</th><th>Modified</th></tr></thead>
    <tbody>
      <tr>
        <td><a href="/xref/release-2.x/pandora/">pandora</a></td>
        <td></td>
        <td>2024-01-01</td>
      </tr>
      <tr>
        <td><a href="/xref/release-2.x/README.md">README.md</a></td>
        <td>1234</td>
        <td>2024-01-02</td>
      </tr>
    </tbody>
  </table>
</body>
</html>
`;

// Real OpenGrok 1.7.x directory listing with icon cells and relative hrefs.
// Directories use <p class="r"/>, files use <p class="p"/>.
export const DIRECTORY_LISTING_REAL_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Directory Listing Real Fixture</title>
</head>
<body>
  <table id="dirlist" class="tablesorter tablesorter-default">
    <tbody>
      <tr>
        <td><p class="r"/></td>
        <td><a href="SignalRouter/"><b>SignalRouter</b></a>/</td>
        <td class="q"><a href="/source/history/release-2.x/pandora/source/NetEngine/MySql/SignalRouter" title="History">H</a></td>
        <td>07-Mar-2026</td>
        <td>-</td>
      </tr>
      <tr>
        <td><p class="p"/></td>
        <td><a href="ShaderPipelineUtils.cpp">ShaderPipelineUtils.cpp</a></td>
        <td class="q"><a href="/source/history/release-2.x/pandora/source/NetEngine/MySql/ShaderPipelineUtils.cpp" title="History">H</a></td>
        <td>07-Mar-2026</td>
        <td>5678</td>
      </tr>
    </tbody>
  </table>
</body>
</html>
`;

export const FILE_HISTORY_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>File History Fixture</title>
</head>
<body>
  <table id="revisions">
    <thead><tr><th>Revision</th><th>Tags</th><th>Date</th><th>Author</th><th>Comments</th></tr></thead>
    <tbody>
      <tr>
        <td><a href="#">abc12345</a></td>
        <td></td>
        <td>2024-01-15</td>
        <td>john.doe</td>
        <td>Fix memory leak. Update Form: 58321 MR: 78502</td>
      </tr>
      <tr>
        <td><a href="#">def67890</a></td>
        <td></td>
        <td>2024-01-10</td>
        <td>jane.smith</td>
        <td>Add retry logic for connection failures</td>
      </tr>
    </tbody>
  </table>
</body>
</html>
`;

// Real OpenGrok 1.7.x history with two <a> tags per revision cell,
// data-revision-* radio inputs, DD-Mon-YYYY dates, author wrapped in <a>,
// and <p class="rev-message-full"> comment structure.
export const FILE_HISTORY_REAL_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>File History Real Fixture</title>
</head>
<body>
  <table class="src" id="revisions" aria-label="table of revisions">
    <tbody>
      <tr><td><a href="http://localhost:8080/source/history/release-2.x/path/file.cpp#851c8156"
              title="link to revision line">#</a>
              <a href="/source/xref/release-2.x/path/file.cpp?r=851c8156">851c8156</a></td>
          <td><input type="radio"
                      aria-label="From"
                      data-revision-1="0"
                      data-revision-2="0"
                      data-diff-revision="r1"
                      data-revision-path="/release-2.x/path/file.cpp@851c8156"
               disabled="disabled" /><input type="radio"
                      aria-label="To"
                      data-revision-1="1"
                      data-revision-2="0"
                      data-diff-revision="r2"
                      data-revision-path="/release-2.x/path/file.cpp@851c8156"
               checked="checked" /></td><td>07-Mar-2026</td>
          <td><a href="https://usermgmt.example.com/user/adev@example.com">Alice Developer &lt;adev@example.com&gt;</a></td>
          <td><a name="851c8156"></a><p class="rev-message-full">GPU Signal Router Pipeline<br/>Update Form 61204 https://tracker.example.com/Form.aspx?BuildID=1100080&amp;FormID=61204<br/>MR-79133</p><div class="filelist-hidden"><br/></div></td>
      </tr><tr><td><a href="http://localhost:8080/source/history/release-2.x/path/file.cpp#7a2b3c4d"
              title="link to revision line">#</a>
              <a href="/source/xref/release-2.x/path/file.cpp?r=7a2b3c4d">7a2b3c4d</a></td>
          <td><input type="radio"
                      aria-label="From"
                      data-revision-1="1"
                      data-revision-2="0"
                      data-diff-revision="r1"
                      data-revision-path="/release-2.x/path/file.cpp@7a2b3c4d"
               checked="checked"/><input type="radio"
                      aria-label="To"
                      data-revision-1="1"
                      data-revision-2="1"
                      data-diff-revision="r2"
                      data-revision-path="/release-2.x/path/file.cpp@7a2b3c4d"
               disabled="disabled" /></td><td>15-Feb-2026</td>
          <td><a href="https://usermgmt.example.com/user/jdoe@example.com">John Doe &lt;jdoe@example.com&gt;</a></td>
          <td><a name="7a2b3c4d"></a><p class="rev-message-full">Initial GPU pipeline support</p><div class="filelist-hidden"><br/></div></td>
      </tr>
    </tbody>
  </table>
</body>
</html>
`;

export const WEB_SEARCH_RESULTS_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Web Search Results Fixture</title>
</head>
<body>
  <div id="results">
    <p class="pagetitle">Searched <span class="bold">defs:PixelBufferRenderer</span> (Results <span class="bold"> 1 – 2</span> of <span class="bold">2</span>) sorted by relevance</p>
    <table aria-label="table of results">
      <tbody class="search-result">
        <tr class="dir"><td colspan="3"><a href="/source/xref/release-2.x/pandora/source/NetEngine/MySql/SignalRouter/">/release-2.x/pandora/source/NetEngine/MySql/SignalRouter/</a></td></tr>
        <tr>
          <td class="q"><a href="/source/history/release-2.x/pandora/source/NetEngine/MySql/SignalRouter/PixelBufferRenderer.h" title="History">H</a></td>
          <td class="f"><a href="/source/xref/release-2.x/pandora/source/NetEngine/MySql/SignalRouter/PixelBufferRenderer.h">PixelBufferRenderer.h</a></td>
          <td><code class="con"><a class="s" href="/source/xref/release-2.x/pandora/source/NetEngine/MySql/SignalRouter/PixelBufferRenderer.h#48"><span class="l">48</span> class PixelBufferRenderer : public Graphics::BaseFrameRenderer</a></code></td>
        </tr>
        <tr>
          <td class="q"><a href="/source/history/release-2.x/pandora/source/NetEngine/MySql/SignalRouter/PixelBufferRenderer.cpp" title="History">H</a></td>
          <td class="f"><a href="/source/xref/release-2.x/pandora/source/NetEngine/MySql/SignalRouter/PixelBufferRenderer.cpp">PixelBufferRenderer.cpp</a></td>
          <td><code class="con"><a class="s" href="/source/xref/release-2.x/pandora/source/NetEngine/MySql/SignalRouter/PixelBufferRenderer.cpp#41"><span class="l">41</span> PixelBufferRenderer::PixelBufferRenderer()</a></code></td>
        </tr>
      </tbody>
    </table>
  </div>
</body>
</html>
`;

export const ANNOTATE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Annotate Fixture</title>
</head>
<body>
  <pre id="src">
    <span class="blame" title="revision: abc12345 author: john.doe date: 2024-01-15">  int x = 0;</span>
    <span class="blame" title="revision: def67890 author: jane.smith date: 2024-01-10">  return x;</span>
  </pre>
</body>
</html>
`;

// Real OpenGrok 1.7.x annotate HTML — title is on child <a class="r">,
// uses changeset/user instead of revision/author, &nbsp; between fields.
// Blame span contains <a class="r"> (hash only), <a class="search">, <a class="a"> (author).
// Line anchors and code content are OUTSIDE the blame span.
export const ANNOTATE_HTML_17X = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Annotate 17x Fixture</title>
</head>
<body>
  <pre id="src"><a class="l" name="1" href="#1">1</a><span class="blame"><a class="r" style="background-color: rgb(234, 255, 226)" href="file.cpp?a=true&amp;r=851c8156" title="changeset:&nbsp;851c8156&lt;br/&gt;summary:&nbsp;MySQL&nbsp;SignalRouter&nbsp;Support&lt;br/&gt;user:&nbsp;Alice&nbsp;Developer&nbsp;&#60;adev@example.com&#62;&lt;br/&gt;date:&nbsp;Tue&nbsp;Dec&nbsp;23&nbsp;15:43:42&nbsp;EST&nbsp;2025&lt;br/&gt;version: 169/176">851c8156</a><a class="search" href="/source/s?defs=&amp;refs=&amp;path=&amp;project=release-2.x&amp;hist=&quot;851c8156&quot;&amp;type=" title="Search history for this revision">S</a><a class="a" href="https://usermgmt.example.com/user/Alice+Developer">Alice Developer</a></span><span class='fold-space'>&nbsp;</span><span class="c">// $CVSHeader$</span>
<a class="l" name="2" href="#2">2</a><span class="blame"><a class="r" style="background-color: rgb(200, 220, 255)" href="file.cpp?a=true&amp;r=aabb1122" title="changeset:&nbsp;aabb1122&lt;br/&gt;summary:&nbsp;Refactor&lt;br/&gt;user:&nbsp;Jane&nbsp;Smith&lt;br/&gt;date:&nbsp;Mon&nbsp;Jan&nbsp;06&nbsp;10:00:00&nbsp;EST&nbsp;2025&lt;br/&gt;version: 42/176">aabb1122</a><a class="search" href="/source/s?defs=&amp;refs=&amp;path=&amp;project=release-2.x&amp;hist=&quot;aabb1122&quot;&amp;type=" title="Search history for this revision">S</a><a class="a" href="https://usermgmt.example.com/user/Jane+Smith">Jane Smith</a></span><span class='fold-space'>&nbsp;</span>#<b>include</b> &quot;library.h&quot;
  </pre>
</body>
</html>
`;

// xref page with intelliWindow-symbol links (for parseFileSymbols)
// Modeled after real OpenGrok 1.7.x output (name= attributes, <a> for symbol
// name anchors and fold icons).
export const XREF_FILE_SYMBOLS_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Xref Symbols Fixture</title>
</head>
<body>
  <div id="src" data-navigate-window-enabled="false">
    <a class="l" name="1" href="#1">1</a><span class='fold-space'>&nbsp;</span>#<b>include</b> <span class="s">&quot;StdAfx.h&quot;</span>
    <a class="l" name="2" href="#2">2</a><span class='fold-space'>&nbsp;</span>
    <a class="l" name="10" href="#10">10</a><span class='fold-space'>&nbsp;</span>#<b>define</b> <a class="xm" name="MAX_BUFFER_SIZE"/><a href="/source/s?refs=MAX_BUFFER_SIZE&amp;project=release-2.x" class="xm intelliWindow-symbol" data-definition-place="def">MAX_BUFFER_SIZE</a> <span class="n">1024</span>
    <a class="l" name="11" href="#11">11</a><span class='fold-space'>&nbsp;</span>#<b>define</b> <a class="xm" name="APP_NAME"/><a href="/source/s?refs=APP_NAME&amp;project=release-2.x" class="xm intelliWindow-symbol" data-definition-place="def">APP_NAME</a> <span class="s">&quot;myapp&quot;</span>
    <a class="l" name="20" href="#20">20</a><span class='fold-space'>&nbsp;</span><b>class</b> <a class="xc" name="MyController"/><a href="/source/s?refs=MyController&amp;project=release-2.x" class="xc intelliWindow-symbol" data-definition-place="def">MyController</a> {
    <a class="l" name="30" href="#30">30</a><span class='fold-space'>&nbsp;</span><b>enum</b> <a class="xe" name="ErrorCode"/><a href="/source/s?refs=ErrorCode&amp;project=release-2.x" class="xe intelliWindow-symbol" data-definition-place="def">ErrorCode</a> { OK, FAIL };
    <span id='scope_id_abc123' class='scope-head'><span class='scope-signature'>Initialize(const char * config,int timeout)</span><a class="hl" name="40" href="#40">40</a><a style='cursor:pointer;' onclick='fold(this.parentNode.id)' id='scope_id_abc123_fold_icon'><span class='fold-icon'>&nbsp;</span></a><b>int</b> <a class="d intelliWindow-symbol" href="#MyController" data-definition-place="defined-in-file">MyController</a>::<a class="xf" name="Initialize"/><a href="/source/s?refs=Initialize&amp;project=release-2.x" class="xf intelliWindow-symbol" data-definition-place="def">Initialize</a>(<b>const</b> <b>char</b> *<a class="xa" name="config"/><a href="/source/s?refs=config&amp;project=release-2.x" class="xa intelliWindow-symbol" data-definition-place="def">config</a>, <b>int</b> <a class="xa" name="timeout"/><a href="/source/s?refs=timeout&amp;project=release-2.x" class="xa intelliWindow-symbol" data-definition-place="def">timeout</a>)</span>
    <span id='scope_id_abc123_fold' class='scope-body'><a class="l" name="41" href="#41">41</a><span class='fold-space'>&nbsp;</span>{
    <a class="l" name="42" href="#42">42</a><span class='fold-space'>&nbsp;</span>    <b>const</b> <b>char</b> *<a class="xl" name="function"/><a href="/source/s?refs=function&amp;project=release-2.x" class="xl intelliWindow-symbol" data-definition-place="def">function</a> = <span class="s">&quot;MyController::Initialize&quot;</span>;
    <a class="l" name="43" href="#43">43</a><span class='fold-space'>&nbsp;</span>    <b>int</b> <a class="xl" name="retCode"/><a href="/source/s?refs=retCode&amp;project=release-2.x" class="xl intelliWindow-symbol" data-definition-place="def">retCode</a> = <span class="n">0</span>;
    <a class="l" name="50" href="#50">50</a><span class='fold-space'>&nbsp;</span>    <a href="/source/s?defs=CQiError&amp;project=release-2.x" class="intelliWindow-symbol" data-definition-place="undefined-in-file">CQiError</a> <a class="xl" name="oError"/><a href="/source/s?refs=oError&amp;project=release-2.x" class="xl intelliWindow-symbol" data-definition-place="def">oError</a>;
    <a class="l" name="60" href="#60">60</a><span class='fold-space'>&nbsp;</span>}</span>
    <span id='scope_id_def456' class='scope-head'><span class='scope-signature'>Cleanup()</span><a class="l" name="70" href="#70">70</a><a style='cursor:pointer;' onclick='fold(this.parentNode.id)' id='scope_id_def456_fold_icon'><span class='fold-icon'>&nbsp;</span></a><b>void</b> <a class="d intelliWindow-symbol" href="#MyController" data-definition-place="defined-in-file">MyController</a>::<a class="xf" name="Cleanup"/><a href="/source/s?refs=Cleanup&amp;project=release-2.x" class="xf intelliWindow-symbol" data-definition-place="def">Cleanup</a>()</span>
    <span id='scope_id_def456_fold' class='scope-body'><a class="l" name="71" href="#71">71</a><span class='fold-space'>&nbsp;</span>{
    <a class="l" name="75" href="#75">75</a><span class='fold-space'>&nbsp;</span>}</span>
    <span id='scope_id_ghi789' class='scope-head'><span class='scope-signature'>ProcessItems(vector&lt;string&gt; &amp; items)</span><a class="l" name="80" href="#80">80</a><a style='cursor:pointer;' onclick='fold(this.parentNode.id)' id='scope_id_ghi789_fold_icon'><span class='fold-icon'>&nbsp;</span></a><b>int</b> <a class="xf" name="ProcessItems"/><a href="/source/s?refs=ProcessItems&amp;project=release-2.x" class="xf intelliWindow-symbol" data-definition-place="def">ProcessItems</a>(<a href="/source/s?defs=vector&amp;project=release-2.x" class="intelliWindow-symbol" data-definition-place="undefined-in-file">vector</a>&lt;<a href="/source/s?defs=string&amp;project=release-2.x" class="intelliWindow-symbol" data-definition-place="undefined-in-file">string</a>&gt; &amp; <a class="xa" name="items"/><a href="/source/s?refs=items&amp;project=release-2.x" class="xa intelliWindow-symbol" data-definition-place="def">items</a>)</span>
  </div>
</body>
</html>
`;
