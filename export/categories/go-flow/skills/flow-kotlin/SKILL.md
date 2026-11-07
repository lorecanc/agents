---
name: flow-kotlin
description: Android and Kotlin work (Jetpack Compose, Views, Room, coroutines/Flow, Gradle) - check SDK levels, ground APIs in the Google Developer Knowledge MCP instead of memory, modern architecture and Compose patterns, permission and background-execution rules, and Gradle build/test commands. Load when writing or reviewing Android/Kotlin code.
---

# Android and Kotlin

## 1. Establish the facts first

- Find `minSdk`, `targetSdk` and `compileSdk`, the Kotlin version, the Compose BOM and the AGP version (`build.gradle(.kts)`, `libs.versions.toml`).
- Every API choice must fit `minSdk`. Gate newer APIs with `Build.VERSION.SDK_INT` checks or AndroidX compat helpers.

## 2. Ground APIs in docs, not memory

Google Developer Knowledge MCP (`google-developer-knowledge_*`):
- Start with `search_documents(query)` using one specific English question that names the product, for example "How to collect flows lifecycle-aware in Jetpack Compose Kotlin".
- Use `get_documents(names)` only on the 1 or 2 parent documents that answer the question.
- `answer_query(query)` is for a grounded synthesis. On HTTP 429, fall back to `search_documents`.
- If the server times out, stop calling it this session and rely on static analysis. Say so in the summary.

## 3. Modern defaults

- **Architecture:** UI, domain (optional) and data layers with unidirectional data flow. The `ViewModel` exposes `StateFlow<UiState>`, and repositories own data sources.
- **Compose:**
  - Hoist state, and keep business logic out of composables.
  - Use `remember`/`rememberSaveable`, and `derivedStateOf` for computed values.
  - Use stable parameters, and collect flows with `collectAsStateWithLifecycle()`.
  - Use Material 3 theming tokens (`MaterialTheme.colorScheme`/`typography`), not hard-coded colors or sizes.
- **Coroutines:**
  - Use `viewModelScope`/`lifecycleScope`, never `GlobalScope`.
  - Inject dispatchers, and do I/O on `Dispatchers.IO`.
  - Use structured concurrency and handle cancellation.
- **Room:** use explicit `Migration`s with tests. `fallbackToDestructiveMigration` only with explicit user consent.
- **Replace deprecated APIs:** `AsyncTask`/`Loader` become coroutines or WorkManager, and `onBackPressed` becomes `OnBackPressedDispatcher` (predictive back).

## 4. Platform rules that bite

- Request runtime permissions in context (for example `POST_NOTIFICATIONS` on 13+) and handle denial.
- Background work goes through WorkManager. Foreground services need a declared type (14+). Exact alarms are restricted (12+).
- Survive process death: keep critical UI state in `SavedStateHandle`, not only in `ViewModel` fields.
- For storage, use scoped storage and MediaStore, and never request broad storage access without a need.

## 5. UI quality

- Apply the `flow-frontend-design` rubric (hierarchy, spacing on a 4/8dp grid, type scale, contrast), adapted to Material 3.
- Tap targets are at least 48dp. Use `contentDescription` on icon-only controls and support font scaling and dark theme.

## 6. Build and test

- Run `./gradlew :<module>:assembleDebug`, `./gradlew :<module>:testDebugUnitTest --tests '<pattern>'`, and `./gradlew lint` when the project has lint configured.
- For instrumented or Compose UI tests, use `connectedDebugAndroidTest` only when an emulator is running. Otherwise report `PARTIALLY VERIFIED`.
