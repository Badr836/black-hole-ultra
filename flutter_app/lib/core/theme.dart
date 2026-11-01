import 'package:flutter/material.dart';

/// BlackHole-inspired palette: near-black backgrounds + violet accents.
class BHColors {
  static const bg = Color(0xFF050308);
  static const bg2 = Color(0xFF0B0712);
  static const card = Color(0xFF110A1C);
  static const card2 = Color(0xFF170E26);
  static const border = Color(0xFF2A1A44);
  static const violet = Color(0xFF8B5CF6);
  static const violet2 = Color(0xFFA78BFA);
  static const fuchsia = Color(0xFFD946EF);
  static const text = Color(0xFFECE6F7);
  static const muted = Color(0xFF9A8FB8);
  static const success = Color(0xFF34D399);
  static const danger = Color(0xFFFB7185);
  static const warning = Color(0xFFFBBF24);
}

ThemeData buildBlackHoleTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  const scheme = ColorScheme.dark(
    primary: BHColors.violet,
    onPrimary: Colors.white,
    secondary: BHColors.fuchsia,
    surface: BHColors.card,
    onSurface: BHColors.text,
    error: BHColors.danger,
  );
  return base.copyWith(
    colorScheme: scheme,
    scaffoldBackgroundColor: BHColors.bg,
    canvasColor: BHColors.bg2,
    cardTheme: CardThemeData(
      color: BHColors.card,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: BHColors.border),
      ),
      margin: EdgeInsets.zero,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.transparent,
      elevation: 0,
      foregroundColor: BHColors.text,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: const Color(0xFF0A0612),
      hintStyle: const TextStyle(color: Color(0xFF6E6389)),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: BHColors.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: BHColors.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: BHColors.violet, width: 1.5),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: BHColors.violet,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: BHColors.text,
        side: const BorderSide(color: BHColors.border),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    chipTheme: base.chipTheme.copyWith(
      backgroundColor: const Color(0xFF0F0919),
      selectedColor: BHColors.violet.withOpacity(0.35),
      side: const BorderSide(color: BHColors.border),
      labelStyle: const TextStyle(color: BHColors.text),
      shape: const StadiumBorder(),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: BHColors.violet2,
      linearTrackColor: Color(0xFF1A1128),
    ),
    dividerColor: BHColors.border,
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: BHColors.card2,
      contentTextStyle: TextStyle(color: BHColors.text),
      behavior: SnackBarBehavior.floating,
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: BHColors.card,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    ),
  );
}
