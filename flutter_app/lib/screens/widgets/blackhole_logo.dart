import 'package:flutter/material.dart';

import '../../core/theme.dart';

/// Animated "black hole" accretion-disk logo drawn in pure Flutter (no assets needed).
class BlackHoleLogo extends StatefulWidget {
  final double size;
  const BlackHoleLogo({super.key, this.size = 44});

  @override
  State<BlackHoleLogo> createState() => _BlackHoleLogoState();
}

class _BlackHoleLogoState extends State<BlackHoleLogo> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 9))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return RotationTransition(
      turns: _c,
      child: Container(
        width: widget.size,
        height: widget.size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: const SweepGradient(colors: [BHColors.violet, BHColors.fuchsia, Color(0xFF4C1D95), BHColors.violet]),
          boxShadow: [BoxShadow(color: BHColors.fuchsia.withOpacity(0.45), blurRadius: 24, spreadRadius: 2)],
        ),
        child: Center(
          child: Container(
            width: widget.size * 0.62,
            height: widget.size * 0.62,
            decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.black),
          ),
        ),
      ),
    );
  }
}
