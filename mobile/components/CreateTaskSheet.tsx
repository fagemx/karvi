import { useState } from 'react';
import { View, Text, TextInput, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../app/hooks/useTheme';
import { BottomSheet } from '../../app/components/ui/BottomSheet';
import { Button } from '../../app/components/ui/Button';
import { createTask } from '../../app/lib/api';

interface CreateTaskSheetProps {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const PRIORITY_OPTIONS = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const ASSIGNEE_OPTIONS = [
  { value: '', label: 'Unassigned' },
  { value: 'engineer_lite', label: 'Engineer Lite' },
  { value: 'engineer_pro', label: 'Engineer Pro' },
  { value: 'architect', label: 'Architect' },
];

export function CreateTaskSheet({ visible, onClose, onSuccess }: CreateTaskSheetProps) {
  const t = useTheme();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState('medium');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!title.trim()) {
      newErrors.title = 'Title is required';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setAssignee('');
    setPriority('medium');
    setErrors({});
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    setLoading(true);
    try {
      await createTask({
        title: title.trim(),
        description: description.trim() || undefined,
        assignee: assignee || undefined,
        priority,
      });
      Alert.alert('Success', 'Task created successfully');
      resetForm();
      onClose();
      onSuccess?.();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to create task');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <BottomSheet visible={visible} onClose={handleClose} title="Create Task">
      <View style={styles.form}>
        <Text style={[styles.inputLabel, { color: t.textSecondary }]}>Title *</Text>
        <View style={[styles.inputBox, { backgroundColor: t.bgSubtle, borderColor: errors.title ? t.danger : t.border }]}>
          <Ionicons name="create-outline" size={16} color={t.textTertiary} />
          <TextInput
            style={[styles.input, { color: t.text }]}
            value={title}
            onChangeText={(text) => {
              setTitle(text);
              if (errors.title) setErrors((prev) => ({ ...prev, title: '' }));
            }}
            placeholder="Enter task title"
            placeholderTextColor={t.placeholder}
            autoCapitalize="sentences"
            autoCorrect
            maxLength={200}
          />
        </View>
        {errors.title && <Text style={[styles.errorText, { color: t.danger }]}>{errors.title}</Text>}

        <Text style={[styles.inputLabel, { color: t.textSecondary }]}>Description</Text>
        <View style={[styles.inputBox, styles.textAreaBox, { backgroundColor: t.bgSubtle, borderColor: t.border }]}>
          <TextInput
            style={[styles.textArea, { color: t.text }]}
            value={description}
            onChangeText={setDescription}
            placeholder="Enter task description (optional)"
            placeholderTextColor={t.placeholder}
            maxLength={2000}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>

        <Text style={[styles.inputLabel, { color: t.textSecondary }]}>Assignee</Text>
        <View style={[styles.inputBox, { backgroundColor: t.bgSubtle, borderColor: t.border }]}>
          <Ionicons name="person-outline" size={16} color={t.textTertiary} />
          <View style={styles.pickerContainer}>
            {ASSIGNEE_OPTIONS.map((opt) => (
              <View key={opt.value} style={styles.chipRow}>
                <Text
                  style={[
                    styles.chip,
                    {
                      backgroundColor: assignee === opt.value ? t.primary : t.bgCard,
                      borderColor: assignee === opt.value ? t.primary : t.border,
                      color: assignee === opt.value ? t.textInverse : t.text,
                    },
                  ]}
                  onPress={() => setAssignee(opt.value)}
                >
                  {opt.label}
                </Text>
              </View>
            ))}
          </View>
        </View>

        <Text style={[styles.inputLabel, { color: t.textSecondary }]}>Priority</Text>
        <View style={[styles.inputBox, { backgroundColor: t.bgSubtle, borderColor: t.border }]}>
          <Ionicons name="flag-outline" size={16} color={t.textTertiary} />
          <View style={styles.pickerContainer}>
            {PRIORITY_OPTIONS.map((opt) => (
              <Text
                key={opt.value}
                style={[
                  styles.chip,
                  {
                    backgroundColor: priority === opt.value ? getPriorityColor(opt.value, t) : t.bgCard,
                    borderColor: priority === opt.value ? getPriorityColor(opt.value, t) : t.border,
                    color: priority === opt.value ? '#fff' : t.text,
                  },
                ]}
                onPress={() => setPriority(opt.value)}
              >
                {opt.label}
              </Text>
            ))}
          </View>
        </View>

        <View style={styles.buttonRow}>
          <Button label="Cancel" variant="ghost" onPress={handleClose} style={styles.button} disabled={loading} />
          <Button
            label={loading ? 'Creating...' : 'Create Task'}
            onPress={handleSubmit}
            loading={loading}
            disabled={loading}
            style={styles.button}
            icon={loading ? undefined : <Ionicons name="add-circle-outline" size={16} color="#fff" />}
          />
        </View>
      </View>
    </BottomSheet>
  );
}

function getPriorityColor(priority: string, t: ReturnType<typeof useTheme>): string {
  switch (priority) {
    case 'high':
      return t.danger;
    case 'medium':
      return t.warning;
    case 'low':
      return t.success;
    default:
      return t.primary;
  }
}

const styles = StyleSheet.create({
  form: {
    gap: 4,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  inputBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  input: {
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  textAreaBox: {
    alignItems: 'flex-start',
    paddingVertical: 8,
  },
  textArea: {
    flex: 1,
    fontSize: 15,
    minHeight: 80,
    padding: 0,
  },
  pickerContainer: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chipRow: {
    marginBottom: 4,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    fontSize: 13,
    fontWeight: '600',
    overflow: 'hidden',
  },
  errorText: {
    fontSize: 12,
    marginTop: 4,
    marginBottom: 4,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
  },
  button: {
    flex: 1,
  },
});
