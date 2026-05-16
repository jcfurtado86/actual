import { forwardRef } from 'react';
import type { ComponentProps } from 'react';

import { theme } from './theme';
import { View } from './View';

type CardProps = ComponentProps<typeof View>;

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ children, ...props }, ref) => {
    return (
      <View
        {...props}
        ref={ref}
        style={{
          marginTop: 18,
          marginLeft: 6,
          marginRight: 6,
          borderRadius: 16,
          backgroundColor: theme.cardBackground,
          borderColor: theme.cardBorder,
          boxShadow:
            '0 10px 30px -10px rgba(15, 23, 42, 0.18), 0 2px 6px rgba(15, 23, 42, 0.06)',
          ...props.style,
        }}
      >
        <View
          style={{
            borderRadius: 16,
            overflow: 'hidden',
          }}
        >
          {children}
        </View>
      </View>
    );
  },
);

Card.displayName = 'Card';
