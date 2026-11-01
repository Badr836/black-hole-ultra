allprojects {
    repositories {
        google()
        mavenCentral()
        // youtubedl-android (bundled Python + yt-dlp + ffmpeg) is published on JitPack.
        // Project-level repositories take precedence over settings.gradle.kts, so the
        // JitPack entry has to be repeated here or the dependency cannot be resolved.
        maven { url = uri("https://jitpack.io") }
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
