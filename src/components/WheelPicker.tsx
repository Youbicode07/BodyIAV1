import React, { useEffect, useRef } from 'react';
import {
  Animated,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, font, radius, spacing } from '../theme/colors';

export const ITEM_HEIGHT = 44;
const VISIBLE = 5;

type Props = {
  label: string;
  values: (string | number)[];
  index: number;
  onChange: (index: number) => void;
  accent?: string;
};

/**
 * Molette verticale, comme la date de naissance de Cal AI.
 *
 * Les valeurs s'éloignent du centre en rapetissant et en s'effaçant : le choix
 * courant se lit sans bandeau ni surlignage lourd. Aucun clavier n'intervient,
 * donc rien ne peut rester bloqué à l'écran.
 *
 * Défilement : une ScrollView, pas une FlatList. L'écran qui héberge la
 * molette défile lui aussi verticalement, et React Native refuse une liste
 * virtualisée imbriquée dans un défilement de même sens — sa fenêtre de rendu
 * suppose qu'elle pilote le défilement, ce qui n'est plus vrai ici.
 * L'avertissement pointait un vrai risque : le recyclage des lignes pouvait
 * blanchir les valeurs pendant le geste.
 *
 * Renoncer à la virtualisation ne coûte rien à cette échelle : les molettes
 * affichent au plus 97 entrées (les années), chacune une hauteur fixe avec un
 * seul texte. C'est aussi ce que fait déjà RulerPicker sur le même écran.
 */
export function WheelPicker({ label, values, index, onChange, accent = colors.brand }: Props) {
  const listRef = useRef<ScrollView>(null);
  const scrollY = useRef(new Animated.Value(index * ITEM_HEIGHT)).current;
  const lastIndex = useRef(index);

  // Position initiale sans animation : la molette s'ouvre déjà sur la bonne valeur.
  useEffect(() => {
    const id = setTimeout(() => {
      listRef.current?.scrollTo({ y: index * ITEM_HEIGHT, animated: false });
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMomentum = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(e.nativeEvent.contentOffset.y / ITEM_HEIGHT);
    const clamped = Math.min(Math.max(next, 0), values.length - 1);
    if (clamped !== lastIndex.current) {
      lastIndex.current = clamped;
      onChange(clamped);
    }
  };

  return (
    <View style={styles.column}>
      <Text style={styles.label}>{label}</Text>

      <View style={styles.viewport}>
        {/* Bandeau de sélection, derrière les valeurs. */}
        <View style={[styles.selection, { borderColor: `${accent}55`, backgroundColor: `${accent}0F` }]} pointerEvents="none" />

        <Animated.ScrollView
          ref={listRef}
          showsVerticalScrollIndicator={false}
          snapToInterval={ITEM_HEIGHT}
          decelerationRate="fast"
          // Sans cela, Android laisse l'écran entier happer le geste et la
          // molette devient impossible à tourner du doigt.
          nestedScrollEnabled
          contentContainerStyle={{ paddingVertical: ITEM_HEIGHT * ((VISIBLE - 1) / 2) }}
          onMomentumScrollEnd={handleMomentum}
          onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
            useNativeDriver: true,
          })}
          scrollEventThrottle={16}
        >
          {values.map((item, i) => {
            // Distance au centre, exprimée en nombre de crans.
            const distance = Animated.divide(
              Animated.subtract(scrollY, i * ITEM_HEIGHT),
              ITEM_HEIGHT,
            );
            const opacity = distance.interpolate({
              inputRange: [-2, -1, 0, 1, 2],
              outputRange: [0.22, 0.5, 1, 0.5, 0.22],
              extrapolate: 'clamp',
            });
            const scale = distance.interpolate({
              inputRange: [-2, -1, 0, 1, 2],
              outputRange: [0.78, 0.9, 1, 0.9, 0.78],
              extrapolate: 'clamp',
            });
            return (
              <Animated.View
                key={String(item)}
                style={[styles.item, { opacity, transform: [{ scale }] }]}
              >
                <Text style={styles.itemText}>{item}</Text>
              </Animated.View>
            );
          })}
        </Animated.ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { flex: 1 },
  label: { ...font.tiny, color: colors.subtext, textTransform: 'uppercase', textAlign: 'center', marginBottom: 4 },
  viewport: { height: ITEM_HEIGHT * VISIBLE, justifyContent: 'center' },
  selection: {
    position: 'absolute',
    left: 2,
    right: 2,
    top: ITEM_HEIGHT * ((VISIBLE - 1) / 2),
    height: ITEM_HEIGHT,
    borderRadius: radius.sm,
    borderWidth: 1,
    backgroundColor: `${colors.brand}10`,
  },
  item: { height: ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  itemText: { ...font.h3, fontSize: 19, color: colors.text },
});
